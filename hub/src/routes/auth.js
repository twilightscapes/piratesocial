import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

// Step 1: Redirect to GitHub OAuth
router.get('/github', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: `${process.env.HUB_URL}/api/auth/github/callback`,
    scope: 'read:user user:email public_repo workflow',
  });
  // Pass redirect hint through OAuth state (e.g. ?redirect=/admin.html)
  if (req.query.redirect) {
    params.set('state', req.query.redirect);
  }
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// Step 2: GitHub callback — exchange code for token, upsert user
router.get('/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const prisma = req.app.locals.prisma;

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      return res.status(400).json({ error: tokenData.error_description });
    }

    // Fetch GitHub user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const ghUser = await userRes.json();

    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { githubId: ghUser.id },
      update: {
        username: ghUser.login,
        displayName: ghUser.name || ghUser.login,
        avatarUrl: ghUser.avatar_url,
        githubToken: tokenData.access_token,
      },
      create: {
        githubId: ghUser.id,
        username: ghUser.login,
        displayName: ghUser.name || ghUser.login,
        avatarUrl: ghUser.avatar_url,
        bio: ghUser.bio || '',
        siteUrl: `https://${ghUser.login}.github.io`,
        feedUrl: `https://${ghUser.login}.github.io/feed.xml`,
        githubToken: tokenData.access_token,
      },
    });

    // Issue JWT
    const jwtToken = jwt.sign(
      { id: user.id, username: user.username, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Check if OAuth state contains a redirect path (e.g. /admin.html)
    const stateRedirect = req.query.state;
    if (stateRedirect && stateRedirect.startsWith('/')) {
      return res.redirect(`${process.env.HUB_URL}${stateRedirect}?token=${jwtToken}`);
    }

    // Determine redirect: existing users or those with a valid siteUrl go to their site
    // Only force setup if they're truly new and haven't set up a site yet
    if (!user.nodeCreated && !user.siteUrl) {
      res.redirect(`${process.env.HUB_URL}/setup.html?token=${jwtToken}`);
    } else {
      const redirectUrl = user.siteUrl || process.env.HUB_URL;
      res.redirect(`${redirectUrl}?token=${jwtToken}`);
    }
  } catch (err) {
    console.error('GitHub OAuth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Get current user from JWT
router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true, username: true, displayName: true, bio: true,
        avatarUrl: true, siteUrl: true, feedUrl: true, location: true,
        camera: true, isAdmin: true, createdAt: true,
        _count: { select: { followers: true, following: true, posts: true } },
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
