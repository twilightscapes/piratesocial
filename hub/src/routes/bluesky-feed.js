import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { createAgent, evictAgentCache } from '../services/bluesky.js';

const router = Router();

// --- Thin Bluesky Proxy (forwards browser's accessJwt) ---

// GET /proxy/timeline — forward getTimeline to Bluesky using browser's JWT
router.get('/proxy/timeline', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const cursor = req.query.cursor;
    let apiUrl = `https://bsky.social/xrpc/app.bsky.feed.getTimeline?limit=${limit}`;
    if (cursor) apiUrl += `&cursor=${encodeURIComponent(cursor)}`;

    console.log('[proxy/timeline] Fetching from bsky.social...');
    const response = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    console.log('[proxy/timeline] bsky.social responded:', response.status);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('[proxy/timeline] bsky.social error body:', errText);
      return res.status(response.status).json({ error: errText || `Bluesky API error ${response.status}` });
    }

    const data = await response.json();
    res.json({ feed: data.feed || [], cursor: data.cursor || null });
  } catch (err) {
    console.error('Proxy timeline error:', err.message);
    res.status(502).json({ error: 'Bluesky API unreachable' });
  }
});

// --- Bluesky Timeline Proxy (legacy — uses server-side auth) ---

// GET /timeline — fetch the user's Bluesky home timeline
router.get('/timeline', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (!user?.blueskyHandle || !user?.blueskyAppPassword) {
    return res.status(400).json({ error: 'Bluesky account not connected' });
  }

  try {
    const agent = await createAgent(user);
    const cursor = req.query.cursor || undefined;
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);

    const response = await agent.getTimeline({ cursor, limit });

    const posts = response.data.feed.map(item => normalizeBskyPost(item.post, item.reason));

    res.json({
      posts,
      cursor: response.data.cursor || null,
    });
  } catch (err) {
    console.error('Bluesky timeline error:', err.status, err.message);
    if (err.status === 401 || err.message?.includes('expired')) evictAgentCache(req.user.id);
    if (err.status === 429) return res.status(429).json({ error: 'Rate limited by Bluesky. Please wait a moment.' });
    res.status(500).json({ error: 'Failed to fetch Bluesky timeline' });
  }
});

// GET /author/:handle — fetch posts by a specific Bluesky user
router.get('/author/:handle', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (!user?.blueskyHandle || !user?.blueskyAppPassword) {
    return res.status(400).json({ error: 'Bluesky account not connected' });
  }

  try {
    const agent = await createAgent(user);
    const cursor = req.query.cursor || undefined;
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);

    const response = await agent.getAuthorFeed({
      actor: req.params.handle,
      cursor,
      limit,
      filter: 'posts_and_author_threads',
    });

    const posts = response.data.feed.map(item => normalizeBskyPost(item.post, item.reason));

    res.json({
      posts,
      cursor: response.data.cursor || null,
    });
  } catch (err) {
    console.error('Bluesky author feed error:', err.status, err.message);
    if (err.status === 401 || err.message?.includes('expired')) evictAgentCache(req.user.id);
    if (err.status === 429) return res.status(429).json({ error: 'Rate limited by Bluesky. Please wait a moment.' });
    res.status(500).json({ error: 'Failed to fetch author feed' });
  }
});

// --- Squads CRUD ---

// GET /squads — list user's squads with members
router.get('/squads', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const squads = await prisma.squad.findMany({
    where: { userId: req.user.id },
    include: { members: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json(squads);
});

// POST /squads — create a squad
router.post('/squads', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  const count = await prisma.squad.count({ where: { userId: req.user.id } });
  if (count >= 20) return res.status(400).json({ error: 'Max 20 squads' });

  const squad = await prisma.squad.create({
    data: { userId: req.user.id, name: name.trim() },
    include: { members: true },
  });
  res.json(squad);
});

// PATCH /squads/:id — update squad (name, activityWindow)
router.patch('/squads/:id', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const squad = await prisma.squad.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!squad) return res.status(404).json({ error: 'Squad not found' });

  const data = {};
  if (req.body.name?.trim()) data.name = req.body.name.trim();
  if (req.body.activityWindow != null) {
    const w = parseInt(req.body.activityWindow);
    if (w >= 15 && w <= 720) data.activityWindow = w;
  }

  const updated = await prisma.squad.update({
    where: { id: squad.id },
    data,
    include: { members: true },
  });
  res.json(updated);
});

// DELETE /squads/:id — delete a squad
router.delete('/squads/:id', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const squad = await prisma.squad.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!squad) return res.status(404).json({ error: 'Squad not found' });

  await prisma.squad.delete({ where: { id: squad.id } });
  res.json({ ok: true });
});

// --- Squad Members ---

// POST /squads/:id/members — add a member by Bluesky handle
router.post('/squads/:id/members', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const squad = await prisma.squad.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!squad) return res.status(404).json({ error: 'Squad not found' });

  const memberCount = await prisma.squadMember.count({ where: { squadId: squad.id } });
  if (memberCount >= 30) return res.status(400).json({ error: 'Max 30 members per squad' });

  let handle = (req.body.handle || '').trim().replace(/^@/, '');
  if (!handle) return res.status(400).json({ error: 'Handle required' });

  // Resolve profile from Bluesky
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  try {
    const agent = await createAgent(user);
    const profile = await agent.getProfile({ actor: handle });
    const p = profile.data;

    const member = await prisma.squadMember.create({
      data: {
        squadId: squad.id,
        handle: p.handle,
        did: p.did,
        displayName: p.displayName || null,
        avatarUrl: p.avatar || null,
      },
    });
    res.json(member);
  } catch (err) {
    if (err.message?.includes('not found') || err.status === 400) {
      return res.status(404).json({ error: 'Bluesky user not found' });
    }
    console.error('Add squad member error:', err.message);
    res.status(500).json({ error: 'Failed to resolve Bluesky profile' });
  }
});

// DELETE /squads/:squadId/members/:memberId — remove a member
router.delete('/squads/:squadId/members/:memberId', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const squad = await prisma.squad.findFirst({
    where: { id: req.params.squadId, userId: req.user.id },
  });
  if (!squad) return res.status(404).json({ error: 'Squad not found' });

  await prisma.squadMember.deleteMany({
    where: { id: req.params.memberId, squadId: squad.id },
  });
  res.json({ ok: true });
});

// --- Activity Check ---

// GET /squads/:id/activity — check which members posted recently
router.get('/squads/:id/activity', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const squad = await prisma.squad.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { members: true },
  });
  if (!squad) return res.status(404).json({ error: 'Squad not found' });
  if (!squad.members.length) return res.json({ members: [] });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user?.blueskyHandle || !user?.blueskyAppPassword) {
    return res.status(400).json({ error: 'Bluesky not connected' });
  }

  try {
    const agent = await createAgent(user);
    const cutoff = new Date(Date.now() - squad.activityWindow * 60 * 1000);

    const results = await Promise.allSettled(
      squad.members.map(async (member) => {
        const feed = await agent.getAuthorFeed({
          actor: member.did || member.handle,
          limit: 1,
          filter: 'posts_no_replies',
        });
        const lastPost = feed.data.feed[0]?.post;
        const lastPostAt = lastPost ? new Date(lastPost.indexedAt) : null;
        const isActive = lastPostAt ? lastPostAt >= cutoff : false;

        // Update cached lastPostAt
        if (lastPostAt) {
          await prisma.squadMember.update({
            where: { id: member.id },
            data: { lastPostAt },
          }).catch(() => {});
        }

        return {
          id: member.id,
          handle: member.handle,
          did: member.did,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          lastPostAt: lastPostAt?.toISOString() || null,
          isActive,
        };
      })
    );

    const members = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    res.json({ activityWindow: squad.activityWindow, members });
  } catch (err) {
    console.error('Activity check error:', err.status, err.message);
    if (err.status === 429) return res.status(429).json({ error: 'Rate limited by Bluesky. Please wait a moment.' });
    res.status(500).json({ error: 'Failed to check activity' });
  }
});

// GET /squads/:id/feed — get combined feed from all squad members
router.get('/squads/:id/feed', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const squad = await prisma.squad.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { members: true },
  });
  if (!squad) return res.status(404).json({ error: 'Squad not found' });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user?.blueskyHandle || !user?.blueskyAppPassword) {
    return res.status(400).json({ error: 'Bluesky not connected' });
  }

  try {
    const agent = await createAgent(user);
    const limit = Math.min(parseInt(req.query.limit) || 5, 10);

    const results = await Promise.allSettled(
      squad.members.map(async (member) => {
        const feed = await agent.getAuthorFeed({
          actor: member.did || member.handle,
          limit,
          filter: 'posts_and_author_threads',
        });
        return feed.data.feed.map(item => normalizeBskyPost(item.post, item.reason));
      })
    );

    const allPosts = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    res.json({ posts: allPosts });
  } catch (err) {
    console.error('Squad feed error:', err.status, err.message);
    if (err.status === 429) return res.status(429).json({ error: 'Rate limited by Bluesky. Please wait a moment.' });
    res.status(500).json({ error: 'Failed to fetch squad feed' });
  }
});

// --- Helpers ---

function normalizeBskyPost(post, reason) {
  const embed = post.embed;
  let embedData = {};
  let imageUrl = null;

  // Images
  if (embed?.$type === 'app.bsky.embed.images#view') {
    embedData.images = embed.images.map(img => ({
      thumb: img.thumb,
      fullsize: img.fullsize,
      alt: img.alt || '',
    }));
    if (embed.images[0]) imageUrl = embed.images[0].fullsize || embed.images[0].thumb;
  }

  // Video
  if (embed?.$type === 'app.bsky.embed.video#view') {
    embedData.video = {
      playlist: embed.playlist,
      thumb: embed.thumbnail,
      alt: embed.alt || '',
    };
  }

  // External link card
  if (embed?.$type === 'app.bsky.embed.external#view') {
    embedData.external = {
      uri: embed.external.uri,
      title: embed.external.title,
      description: embed.external.description,
      thumb: embed.external.thumb,
    };
  }

  // Record with media (quote + images/video)
  if (embed?.$type === 'app.bsky.embed.recordWithMedia#view') {
    const media = embed.media;
    if (media?.$type === 'app.bsky.embed.images#view') {
      embedData.images = media.images.map(img => ({
        thumb: img.thumb,
        fullsize: img.fullsize,
        alt: img.alt || '',
      }));
      if (media.images[0]) imageUrl = media.images[0].fullsize || media.images[0].thumb;
    }
    if (media?.$type === 'app.bsky.embed.video#view') {
      embedData.video = { playlist: media.playlist, thumb: media.thumbnail, alt: media.alt || '' };
    }
    const rec = embed.record?.record;
    if (rec?.value?.text) {
      embedData.quote = {
        text: rec.value.text,
        author: rec.author?.displayName || rec.author?.handle || '',
        handle: rec.author?.handle || '',
        avatar: rec.author?.avatar || '',
      };
    }
  }

  // Quote post
  if (embed?.$type === 'app.bsky.embed.record#view') {
    const rec = embed.record;
    if (rec?.value?.text) {
      embedData.quote = {
        text: rec.value.text,
        author: rec.author?.displayName || rec.author?.handle || '',
        handle: rec.author?.handle || '',
        avatar: rec.author?.avatar || '',
      };
    }
  }

  return {
    uri: post.uri,
    cid: post.cid,
    author: {
      handle: post.author.handle,
      displayName: post.author.displayName || post.author.handle,
      avatar: post.author.avatar || '',
      did: post.author.did,
    },
    text: post.record?.text || '',
    pubDate: post.indexedAt,
    imageUrl,
    embedData: Object.keys(embedData).length ? embedData : null,
    likeCount: post.likeCount || 0,
    repostCount: post.repostCount || 0,
    replyCount: post.replyCount || 0,
    repostBy: reason?.$type === 'app.bsky.feed.defs#reasonRepost'
      ? { handle: reason.by.handle, displayName: reason.by.displayName || reason.by.handle }
      : null,
    link: `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}`,
  };
}

export default router;
