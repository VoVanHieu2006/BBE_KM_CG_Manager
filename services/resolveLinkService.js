const axios = require('axios');
const { getShareCache, setShareCache } = require('../repositories/sheetRepository');
const { parseFacebookUrl } = require('../utils/linkParser');

const memCache = new Map();
let lastRequestTime = 0;
const THROTTLE_MS = 2500;

async function throttleDelay() {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < THROTTLE_MS) {
        await new Promise(resolve => setTimeout(resolve, THROTTLE_MS - elapsed));
    }
    lastRequestTime = Date.now();
}

async function resolveShareLink(rawUrl) {
    if (memCache.has(rawUrl)) return memCache.get(rawUrl);

    const cached = await getShareCache(rawUrl).catch(() => null);
    if (cached && cached.guestId) {
        memCache.set(rawUrl, cached);
        return cached;
    }

    try {
        await throttleDelay();
        const response = await axios.get(rawUrl, {
            maxRedirects: 5,
            timeout: 10000,
            headers: {
                'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_codedoc.html)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            validateStatus: () => true,
        });

        const finalUrl = response.request.res.responseUrl || response.request._currentUrl || rawUrl;
        const parsed = parseFacebookUrl(finalUrl);

        if (parsed && parsed.guestId && !parsed.sourceType.startsWith('share') && !parsed.sourceType.startsWith('share-')) {
            const result = {
                originalLink: parsed.canonicalUrl,
                guestId: parsed.guestId,
                sourceType: parsed.sourceType,
                resolvedFrom: rawUrl,
            };
            memCache.set(rawUrl, result);
            setShareCache(rawUrl, result.originalLink, result.guestId).catch(() => {});
            return result;
        }
    } catch (e) {
        // silent fail
    }

    return null;
}

async function resolveAllShareLinks(links) {
    const resolved = [];
    for (const link of links) {
        if (link.needsResolve) {
            const result = await resolveShareLink(link.rawUrl);
            if (result && result.guestId) {
                resolved.push({
                    ...link,
                    guestId: result.guestId,
                    canonicalUrl: result.originalLink,
                    sourceType: `resolved-${result.sourceType || link.sourceType}`,
                    rawUrl: link.rawUrl,
                    resolvedFromShare: true,
                });
            } else {
                resolved.push(link);
            }
        } else {
            resolved.push(link);
        }
    }
    return resolved;
}

module.exports = { resolveShareLink, resolveAllShareLinks };
