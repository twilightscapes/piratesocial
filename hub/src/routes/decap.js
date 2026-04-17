import { Router } from 'express';

const router = Router();

/**
 * Decap CMS OAuth proxy.
 * Decap opens a popup to /api/decap/auth, which redirects to GitHub.
 * GitHub calls back to /api/decap/callback, and we serve an HTML page
 * that posts the token back to the CMS via window.opener.postMessage.
 */

// Step 1: Redirect to GitHub OAuth with public repo scope for Decap CMS
router.get('/auth', (_req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DECAP_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID,
    redirect_uri: `${process.env.HUB_URL}/api/decap/callback`,
    scope: 'public_repo,user',
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// Step 2: GitHub callback — exchange code for token, send back to CMS popup
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.DECAP_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.DECAP_GITHUB_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      return res.status(400).send(`OAuth error: ${tokenData.error_description}`);
    }

    const token = tokenData.access_token;
    const provider = 'github';

    // Decap CMS expects this exact postMessage format
    const html = `<!doctype html><html><body><script>
(function() {
  function recieveMessage(e) {
    console.log("recieveMessage %o", e);
    window.opener.postMessage(
      'authorization:${provider}:success:${JSON.stringify({ token, provider })}',
      e.origin
    );
    window.removeEventListener("message", recieveMessage, false);
  }
  window.addEventListener("message", recieveMessage, false);
  window.opener.postMessage("authorizing:${provider}", "*");
})();
</script></body></html>`;

    res.send(html);
  } catch (err) {
    console.error('Decap OAuth error:', err);
    res.status(500).send('Authentication failed');
  }
});

export default router;
