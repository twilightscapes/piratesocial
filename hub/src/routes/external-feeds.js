import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { XMLParser } from 'fast-xml-parser';

const router = Router();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['item', 'entry'].includes(name),
});

// List current user's external feeds
router.get('/', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;

  const feeds = await prisma.externalFeed.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { posts: true } } },
  });

  res.json({ feeds });
});

// Add a new external RSS feed
router.post('/', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  let { feedUrl } = req.body;

  if (!feedUrl || typeof feedUrl !== 'string') {
    return res.status(400).json({ error: 'feedUrl is required' });
  }

  feedUrl = feedUrl.trim();

  // Validate URL format
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'URL must use http or https' });
  }

  // Limit per user
  const count = await prisma.externalFeed.count({ where: { userId: req.user.id } });
  if (count >= 100) {
    return res.status(400).json({ error: 'Maximum of 100 external feeds allowed' });
  }

  // Fetch and validate the feed
  let feedMeta;
  try {
    feedMeta = await fetchFeedMeta(feedUrl);
  } catch (err) {
    return res.status(400).json({ error: `Could not fetch feed: ${err.message}` });
  }

  try {
    const feed = await prisma.externalFeed.create({
      data: {
        userId: req.user.id,
        feedUrl,
        title: feedMeta.title || null,
        siteUrl: feedMeta.siteUrl || null,
        description: feedMeta.description || null,
        iconUrl: feedMeta.iconUrl || null,
      },
    });

    // Immediately fetch existing posts from the feed
    const newPosts = await aggregateExternalFeed(prisma, feed);

    res.status(201).json({ feed, newPosts });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You are already following this feed' });
    }
    throw err;
  }
});

// Get posts from a specific external feed
router.get('/:feedId/posts', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

  // Ensure the feed belongs to the user
  const feed = await prisma.externalFeed.findFirst({
    where: { id: req.params.feedId, userId: req.user.id },
  });
  if (!feed) return res.status(404).json({ error: 'Feed not found' });

  const [posts, total] = await Promise.all([
    prisma.externalPost.findMany({
      where: { feedId: feed.id },
      orderBy: { pubDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.externalPost.count({ where: { feedId: feed.id } }),
  ]);

  res.json({ feed, posts, total, page, limit, hasMore: page * limit < total });
});

// Update an external feed (toggle active, set maxPosts)
router.patch('/:feedId', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { active, maxPosts } = req.body;

  const feed = await prisma.externalFeed.findFirst({
    where: { id: req.params.feedId, userId: req.user.id },
  });
  if (!feed) return res.status(404).json({ error: 'Feed not found' });

  const data = {};
  if (typeof active === 'boolean') data.active = active;
  if (typeof maxPosts === 'number') {
    data.maxPosts = Math.max(1, Math.min(100, maxPosts));
  }

  const updated = await prisma.externalFeed.update({
    where: { id: feed.id },
    data,
  });

  // Prune excess posts if maxPosts was lowered
  if (data.maxPosts) {
    const postCount = await prisma.externalPost.count({ where: { feedId: feed.id } });
    if (postCount > data.maxPosts) {
      const toKeep = await prisma.externalPost.findMany({
        where: { feedId: feed.id },
        orderBy: { pubDate: 'desc' },
        take: data.maxPosts,
        select: { id: true },
      });
      const keepIds = toKeep.map(p => p.id);
      await prisma.externalPost.deleteMany({
        where: { feedId: feed.id, id: { notIn: keepIds } },
      });
    }
  }

  res.json({ feed: updated });
});

// Delete an external feed and its posts
router.delete('/:feedId', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;

  const feed = await prisma.externalFeed.findFirst({
    where: { id: req.params.feedId, userId: req.user.id },
  });
  if (!feed) return res.status(404).json({ error: 'Feed not found' });

  await prisma.externalFeed.delete({ where: { id: feed.id } });

  res.json({ deleted: true });
});

// Manually refresh a specific external feed
router.post('/:feedId/refresh', authenticate, async (req, res) => {
  const prisma = req.app.locals.prisma;

  const feed = await prisma.externalFeed.findFirst({
    where: { id: req.params.feedId, userId: req.user.id },
  });
  if (!feed) return res.status(404).json({ error: 'Feed not found' });

  const count = await aggregateExternalFeed(prisma, feed);

  res.json({ newPosts: count });
});

/**
 * Fetch feed metadata (title, siteUrl, description) to validate + display.
 */
async function fetchFeedMeta(feedUrl) {
  const response = await fetch(feedUrl, {
    headers: { 'User-Agent': 'PirateSocial-Hub/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const xml = await response.text();
  const feed = parser.parse(xml);

  const channel = feed?.rss?.channel;
  const atomFeed = feed?.feed;

  if (!channel && !atomFeed) throw new Error('Not a valid RSS or Atom feed');

  if (channel) {
    return {
      title: channel.title || null,
      siteUrl: channel.link || null,
      description: channel.description || null,
      iconUrl: channel.image?.url || null,
    };
  }

  return {
    title: atomFeed.title || null,
    siteUrl: atomFeed.link?.['@_href'] || atomFeed.link || null,
    description: atomFeed.subtitle || null,
    iconUrl: atomFeed.icon || atomFeed.logo || null,
  };
}

/**
 * Fetch and store posts from a single external feed.
 */
export async function aggregateExternalFeed(prisma, feed) {
  let xml;
  try {
    const response = await fetch(feed.feedUrl, {
      headers: { 'User-Agent': 'PirateSocial-Hub/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await prisma.externalFeed.update({
        where: { id: feed.id },
        data: { errorCount: { increment: 1 } },
      });
      return 0;
    }
    xml = await response.text();
  } catch {
    await prisma.externalFeed.update({
      where: { id: feed.id },
      data: { errorCount: { increment: 1 } },
    });
    return 0;
  }

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch {
    return 0;
  }

  const channel = parsed?.rss?.channel;
  const atomFeed = parsed?.feed;
  let items = channel?.item || atomFeed?.entry || [];

  // Limit to maxPosts most recent items
  if (feed.maxPosts && items.length > feed.maxPosts) {
    items = items.slice(0, feed.maxPosts);
  }

  // Update feed metadata if it changed
  const meta = {};
  const newTitle = channel?.title || atomFeed?.title;
  if (newTitle && newTitle !== feed.title) meta.title = newTitle;
  const newSiteUrl = channel?.link || atomFeed?.link?.['@_href'] || atomFeed?.link;
  if (newSiteUrl && typeof newSiteUrl === 'string' && newSiteUrl !== feed.siteUrl) meta.siteUrl = newSiteUrl;

  let newCount = 0;

  for (const item of items) {
    const guid = item.guid?.['#text'] || item.guid || item.id || item.link?.['@_href'] || item.link;
    if (!guid) continue;

    const existing = await prisma.externalPost.findUnique({
      where: { feedId_guid: { feedId: feed.id, guid } },
    });
    if (existing) continue;

    // Extract image from common RSS patterns
    const imageUrl =
      item['media:content']?.['@_url'] ||
      item['media:thumbnail']?.['@_url'] ||
      (item.enclosure?.['@_type']?.startsWith('image/') ? item.enclosure['@_url'] : null) ||
      extractImageFromContent(item.description || item['content:encoded'] || item.content?.['#text'] || '') ||
      null;

    const tags = extractTagsFromItem(item);

    const rawDesc = stripHtml(item.description || item.summary || '');
    // Use description preview as title for title-less posts (e.g. Bluesky)
    const title = item.title || (rawDesc ? rawDesc.slice(0, 120) + (rawDesc.length > 120 ? '…' : '') : 'Untitled');

    try {
      await prisma.externalPost.create({
        data: {
          feedId: feed.id,
          guid,
          title,
          description: rawDesc,
          content: item['content:encoded'] || item.content?.['#text'] || item.content || '',
          link: item.link?.['@_href'] || item.link || '',
          pubDate: parseDate(item.pubDate || item.published || item.updated),
          imageUrl,
          author: item.author?.name || item.author || item['dc:creator'] || null,
          tags,
        },
      });
      newCount++;
    } catch {
      // Skip duplicate or invalid entries
    }
  }

  // Update feed metadata and reset error count on success
  await prisma.externalFeed.update({
    where: { id: feed.id },
    data: { lastFetched: new Date(), errorCount: 0, ...meta },
  });

  // Prune oldest posts if over maxPosts limit
  if (feed.maxPosts) {
    const postCount = await prisma.externalPost.count({ where: { feedId: feed.id } });
    if (postCount > feed.maxPosts) {
      const toKeep = await prisma.externalPost.findMany({
        where: { feedId: feed.id },
        orderBy: { pubDate: 'desc' },
        take: feed.maxPosts,
        select: { id: true },
      });
      const keepIds = toKeep.map(p => p.id);
      await prisma.externalPost.deleteMany({
        where: { feedId: feed.id, id: { notIn: keepIds } },
      });
    }
  }

  // Enrich Bluesky posts with images/embeds via public API
  if (isBlueskyFeed(feed.feedUrl)) {
    await enrichBlueskyPosts(prisma, feed.id);
  }

  return newCount;
}

/**
 * Aggregate all active external feeds (called from cron).
 */
export async function aggregateAllExternalFeeds(prisma) {
  const feeds = await prisma.externalFeed.findMany({
    where: { active: true, errorCount: { lt: 10 } },
  });

  console.log(`[aggregator] Processing ${feeds.length} external feeds`);
  let totalNew = 0;

  for (let i = 0; i < feeds.length; i += 10) {
    const batch = feeds.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(feed => aggregateExternalFeed(prisma, feed))
    );
    for (const result of results) {
      if (result.status === 'fulfilled') totalNew += result.value;
    }
  }

  console.log(`[aggregator] External feeds: ${totalNew} new posts`);
  return totalNew;
}

/**
 * Extract first image URL from HTML content (for feature images in blog posts).
 */
function extractImageFromContent(html) {
  if (!html) return null;
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim().slice(0, 500);
}

function extractTagsFromItem(item) {
  const categories = item.category;
  if (!categories) return [];
  const cats = Array.isArray(categories) ? categories : [categories];
  return cats.map(c => (typeof c === 'string' ? c : c['#text'] || c).toLowerCase().trim()).filter(Boolean);
}

function parseDate(dateStr) {
  if (!dateStr) return new Date();
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Check if a feed URL is a Bluesky RSS feed.
 */
function isBlueskyFeed(feedUrl) {
  return feedUrl.includes('bsky.app/profile/') && feedUrl.endsWith('/rss');
}

/**
 * Enrich Bluesky posts that lack embedData by fetching from the public API.
 */
async function enrichBlueskyPosts(prisma, feedId) {
  // Find posts with AT URI guids that don't yet have embed data
  const posts = await prisma.externalPost.findMany({
    where: { feedId, embedData: null, guid: { startsWith: 'at://' } },
    select: { id: true, guid: true },
    take: 25, // API limit per request
  });

  if (posts.length === 0) return;

  const uris = posts.map(p => p.guid);
  const params = new URLSearchParams();
  uris.forEach(u => params.append('uris', u));

  try {
    const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${params}`, {
      headers: { 'User-Agent': 'PirateSocial-Hub/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;

    const data = await res.json();
    const postMap = new Map();
    for (const p of data.posts || []) {
      postMap.set(p.uri, p);
    }

    for (const post of posts) {
      const bskyPost = postMap.get(post.guid);
      if (!bskyPost) continue;

      const embedData = extractBlueskyEmbed(bskyPost);
      const updates = { embedData };

      // Use first image as imageUrl if not set
      if (embedData.images?.length > 0) {
        updates.imageUrl = embedData.images[0].fullsize || embedData.images[0].thumb;
      }

      // Use author display name
      if (bskyPost.author?.displayName) {
        updates.author = bskyPost.author.displayName;
      }

      await prisma.externalPost.update({
        where: { id: post.id },
        data: updates,
      });
    }
  } catch (err) {
    console.warn('[bluesky-enrich] Failed to fetch post data:', err.message);
  }
}

/**
 * Extract embed data from a Bluesky post view.
 */
function extractBlueskyEmbed(post) {
  const embed = post.embed;
  const result = {};

  if (!embed) return result;

  const type = embed.$type;

  // Images
  if (type === 'app.bsky.embed.images#view') {
    result.images = (embed.images || []).map(img => ({
      thumb: img.thumb,
      fullsize: img.fullsize,
      alt: img.alt || '',
      aspectRatio: img.aspectRatio || null,
    }));
  }

  // External link (link card)
  if (type === 'app.bsky.embed.external#view') {
    result.external = {
      uri: embed.external?.uri,
      title: embed.external?.title,
      description: embed.external?.description,
      thumb: embed.external?.thumb,
    };
  }

  // Video
  if (type === 'app.bsky.embed.video#view') {
    result.video = {
      thumb: embed.thumbnail,
      playlist: embed.playlist, // HLS playlist URL
      aspectRatio: embed.aspectRatio || null,
      alt: embed.alt || '',
    };
  }

  // Quote post
  if (type === 'app.bsky.embed.record#view') {
    const rec = embed.record?.value || embed.record?.record;
    result.quote = {
      text: rec?.text || '',
      author: embed.record?.author?.displayName || embed.record?.author?.handle || '',
      handle: embed.record?.author?.handle || '',
      uri: embed.record?.uri || '',
    };
  }

  // Record with media (quote + images/video)
  if (type === 'app.bsky.embed.recordWithMedia#view') {
    // Extract media part
    const media = embed.media;
    if (media?.$type === 'app.bsky.embed.images#view') {
      result.images = (media.images || []).map(img => ({
        thumb: img.thumb,
        fullsize: img.fullsize,
        alt: img.alt || '',
        aspectRatio: img.aspectRatio || null,
      }));
    }
    if (media?.$type === 'app.bsky.embed.video#view') {
      result.video = {
        thumb: media.thumbnail,
        playlist: media.playlist,
        aspectRatio: media.aspectRatio || null,
        alt: media.alt || '',
      };
    }
    // Extract quote part
    const rec = embed.record?.record?.value || embed.record?.record?.record;
    result.quote = {
      text: rec?.text || '',
      author: embed.record?.record?.author?.displayName || embed.record?.record?.author?.handle || '',
      handle: embed.record?.record?.author?.handle || '',
      uri: embed.record?.record?.uri || '',
    };
  }

  return result;
}

export default router;
