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
