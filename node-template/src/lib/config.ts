import settings from '../data/settings.json';

/** Site-wide configuration — edit via /admin or settings.json */
export const siteConfig = {
  title: settings.title || 'My Photo Site',
  description: settings.description || 'A photography site on the Pirate Social network',
  author: settings.author || 'Todd',
  bio: settings.bio || 'I take photos of things.',
  avatar: settings.avatar || '/images/avatar.jpg',
  location: settings.location || '',
  camera: settings.camera || '',
  siteUrl: settings.github ? `https://${settings.github}.github.io` : 'https://twilightscapes.github.io',
  hubUrl: 'https://piratesocial-hub-production.up.railway.app',
  social: {
    github: settings.github || 'twilightscapes',
    instagram: settings.instagram || '',
    mastodon: settings.mastodon || '',
  },
};
