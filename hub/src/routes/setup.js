import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { provisionNode } from '../services/provision.js';

const router = Router();

// Provision a new node site for the authenticated user
router.post('/provision', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.githubToken) {
    return res.status(400).json({
      error: 'GitHub token missing — please sign in again',
    });
  }

  const { displayName, siteTitle, bio, location, camera, repoName } = req.body;

  try {
    const result = await provisionNode(user, {
      displayName: displayName || user.displayName || user.username,
      siteTitle: siteTitle || '',
      bio: bio || user.bio || '',
      location: location || user.location || '',
      camera: camera || user.camera || '',
      repoName: repoName || `${user.username}.github.io`,
    });

    // Update user profile + mark node as created
    await prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: displayName || user.displayName,
        bio: bio || user.bio,
        location: location || user.location,
        camera: camera || user.camera,
        siteUrl: result.siteUrl,
        feedUrl: `${result.siteUrl}/feed.xml`,
        nodeCreated: true,
      },
    });

    res.json(result);
  } catch (err) {
    console.error('[setup] Provision failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: reset nodeCreated so user can re-provision
router.post('/reset', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const admin = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!admin?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  await prisma.user.updateMany({
    where: { username },
    data: { nodeCreated: false },
  });

  res.json({ ok: true, message: `${username} can re-provision` });
});

// Admin: push latest deploy workflow to a user's repo
router.post('/repair', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const admin = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!admin?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { username, repoName } = req.body;
  if (!username || !repoName) {
    return res.status(400).json({ error: 'username and repoName required' });
  }

  const targetUser = await prisma.user.findFirst({ where: { username } });
  if (!targetUser?.githubToken) {
    return res.status(400).json({ error: 'User has no stored GitHub token' });
  }

  const token = targetUser.githubToken;
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  try {
    // Fetch latest deploy workflow from template
    const templateRes = await fetch(
      'https://api.github.com/repos/twilightscapes/piratesocial/contents/node-template/.github/workflows/deploy.yml',
      { headers }
    );
    if (!templateRes.ok) throw new Error('Failed to fetch template workflow');
    const templateData = await templateRes.json();

    // Check if workflow exists in user's repo (need SHA to update)
    const existingRes = await fetch(
      `https://api.github.com/repos/${username}/${repoName}/contents/.github/workflows/deploy.yml`,
      { headers }
    );
    const existingData = existingRes.ok ? await existingRes.json() : null;

    // Push updated workflow
    const putRes = await fetch(
      `https://api.github.com/repos/${username}/${repoName}/contents/.github/workflows/deploy.yml`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: 'chore: update deploy workflow from Pirate Social template',
          content: templateData.content.replace(/\n/g, ''),
          ...(existingData?.sha ? { sha: existingData.sha } : {}),
        }),
      }
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      throw new Error(`Failed to push workflow: ${putRes.status} ${err}`);
    }

    res.json({ ok: true, message: `Updated workflow in ${username}/${repoName}` });
  } catch (err) {
    console.error('[setup/repair]', err);
    res.status(500).json({ error: err.message });
  }
});

// Check if the user's node is already set up
router.get('/status', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { nodeCreated: true, siteUrl: true, username: true },
  });

  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    nodeCreated: user.nodeCreated,
    siteUrl: user.siteUrl,
    repoUrl: `https://github.com/${user.username}/${user.username}.github.io`,
  });
});

export default router;
