import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Get personalized timeline (posts from people you follow + external feeds)
router.get('/', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const source = req.query.source; // "pirate", "external", or undefined (all)

  // Get IDs of users the current user follows
  const following = await prisma.follow.findMany({
    where: { followerId: req.user.id },
    select: { followingId: true },
  });
  const followingIds = following.map(f => f.followingId);

  // Include own posts in timeline
  followingIds.push(req.user.id);

  // Build pirate posts query
  const piratePosts = source === 'external' ? [] : await prisma.post.findMany({
    where: { userId: { in: followingIds } },
    orderBy: { pubDate: 'desc' },
    take: limit * 2, // fetch extra to merge-sort
    skip: 0,
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      _count: { select: { likes: true, comments: true } },
      likes: {
        where: { userId: req.user.id },
        select: { id: true },
      },
    },
  });

  // Build external posts query
  const externalPosts = source === 'pirate' ? [] : await prisma.externalPost.findMany({
    where: {
      feed: { userId: req.user.id, active: true },
    },
    orderBy: { pubDate: 'desc' },
    take: limit * 2,
    skip: 0,
    include: {
      feed: { select: { id: true, title: true, siteUrl: true, iconUrl: true } },
    },
  });

  // Normalize both types into a common shape
  const normalizedPirate = piratePosts.map(post => ({
    ...post,
    source: 'pirate',
    hasLiked: post.likes.length > 0,
    likes: undefined,
    likeCount: post._count.likes,
    commentCount: post._count.comments,
  }));

  const normalizedExternal = externalPosts.map(post => ({
    id: post.id,
    title: post.title,
    description: post.description,
    content: post.content,
    link: post.link,
    pubDate: post.pubDate,
    imageUrl: post.imageUrl,
    tags: post.tags,
    author: post.author,
    embedData: post.embedData,
    createdAt: post.createdAt,
    source: 'external',
    feed: post.feed,
    hasLiked: false,
    likeCount: 0,
    commentCount: 0,
  }));

  // Merge and sort by pubDate descending
  const merged = [...normalizedPirate, ...normalizedExternal]
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Paginate the merged result
  const start = (page - 1) * limit;
  const paged = merged.slice(start, start + limit);
  const total = merged.length;

  res.json({ posts: paged, total, page, limit, hasMore: start + limit < total });
});

// Global/discover timeline (all public posts)
router.get('/discover', optionalAuth, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const tag = req.query.tag;

  const where = tag ? { tags: { has: tag } } : {};

  const [posts, total] = await Promise.all([
    prisma.post.findMany({
      where,
      orderBy: { pubDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        _count: { select: { likes: true, comments: true } },
        ...(req.user ? {
          likes: { where: { userId: req.user.id }, select: { id: true } },
        } : {}),
      },
    }),
    prisma.post.count({ where }),
  ]);

  const enrichedPosts = posts.map(post => ({
    ...post,
    hasLiked: req.user ? (post.likes?.length > 0) : false,
    likes: undefined,
    likeCount: post._count.likes,
    commentCount: post._count.comments,
  }));

  res.json({ posts: enrichedPosts, total, page, limit, hasMore: page * limit < total });
});

// Search posts
router.get('/search', optionalAuth, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: 'Search query required' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

  const posts = await prisma.post.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { tags: { has: q.toLowerCase() } },
      ],
    },
    orderBy: { pubDate: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      _count: { select: { likes: true, comments: true } },
    },
  });

  res.json({ posts, page, limit });
});

export default router;
