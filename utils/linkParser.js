const crypto = require('crypto');

function normalizeFacebookHost(hostname) {
    const host = hostname.toLowerCase();
    if (host === 'fb.me' || host.endsWith('.fb.me')) return 'fb.me';
    return 'facebook.com';
}

function isFacebookHost(hostname) {
    const host = hostname.toLowerCase();
    return (
        host === 'facebook.com' ||
        host === 'fb.com' ||
        host === 'fb.me' ||
        host.endsWith('.facebook.com') ||
        host.endsWith('.fb.com') ||
        host.endsWith('.fb.me')
    );
}

function stableHash(input) {
    return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function extractUrlCandidates(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.match(urlRegex) || [];
}

function normalizeFacebookUrl(rawUrl) {
    const cleanUrl = new URL(rawUrl);

    if (!isFacebookHost(cleanUrl.hostname)) {
        return null;
    }

    cleanUrl.hostname = normalizeFacebookHost(cleanUrl.hostname);

    const removableParams = [
        'mibextid',
        'eav',
        'paipv',
        'rdid',
        'share_url',
        'fbclid',
        'ref',
        'refsrc',
        'locale',
        'tracking',
        '__cft__',
        '__tn__',
        '__xts__',
        '_rdc',
        '_rdr',
    ];

    removableParams.forEach(param => cleanUrl.searchParams.delete(param));
    cleanUrl.pathname = cleanUrl.pathname.replace(/\/+$/, '') || '/';

    return cleanUrl;
}

function buildFacebookIdentity(cleanUrl, rawUrl) {
    const canonicalUrl = cleanUrl.toString();
    const pathname = cleanUrl.pathname;
    const idParam = cleanUrl.searchParams.get('id');
    const fbidParam = cleanUrl.searchParams.get('fbid');

    if (pathname === '/profile.php' && idParam) {
        return {
            guestId: `profile:id:${idParam}`,
            canonicalUrl,
            rawUrl,
            sourceType: 'profile-id',
        };
    }

    if (pathname === '/profile.php' && fbidParam) {
        return {
            guestId: `profile:fbid:${fbidParam}`,
            canonicalUrl,
            rawUrl,
            sourceType: 'profile-fbid',
        };
    }

    const shareMatch = pathname.match(/^\/share\/([a-zA-Z0-9_-]+)$/);
    if (shareMatch) {
        return {
            guestId: `share:${stableHash(canonicalUrl)}`,
            canonicalUrl,
            rawUrl,
            sourceType: 'share',
            needsResolve: true,
        };
    }

    if (cleanUrl.hostname === 'fb.me' || cleanUrl.hostname.endsWith('.fb.me')) {
        const fbmeMatch = pathname.match(/^\/([a-zA-Z0-9_-]+)$/);
        if (fbmeMatch && fbmeMatch[1].length >= 5) {
            return {
                guestId: `share:${stableHash(canonicalUrl)}`,
                canonicalUrl,
                rawUrl,
                sourceType: 'share-fbme',
                needsResolve: true,
            };
        }
    }

    const peopleMatch = pathname.match(/^\/people\/[^/]+\/([a-zA-Z0-9.]+)/);
    if (peopleMatch) {
        const id = peopleMatch[1];
        if (/^\d+$/.test(id)) {
            return {
                guestId: `profile:id:${id}`,
                canonicalUrl: `${cleanUrl.origin}/profile.php?id=${id}`,
                rawUrl,
                sourceType: 'people-id',
            };
        } else {
            return {
                guestId: `profile:pfbid:${id}`,
                canonicalUrl,
                rawUrl,
                sourceType: 'people-pfbid',
                needsResolve: true,
            };
        }
    }

    const usernameMatch = pathname.match(/^\/([a-zA-Z0-9.]+)$/);
    if (usernameMatch) {
        const username = usernameMatch[1].replace(/\/$/, '').toLowerCase();
        const invalidPaths = new Set([
            'profile.php', 'groups', 'pages', 'events', 'watch', 'story.php',
            'login', 'login.php', 'checkpoint', 'checkpoint.php', 'r.php', 'reg', 'register'
        ]);

        if (!invalidPaths.has(username)) {
            return {
                guestId: `profile:username:${username}`,
                canonicalUrl: `${cleanUrl.origin}/${username}`,
                rawUrl,
                sourceType: 'profile-username',
            };
        }
    }

    const IDENTITY_PARAMS = ['profile_id', 'id', 'fbid', 'uid'];
    for (const param of IDENTITY_PARAMS) {
        const value = cleanUrl.searchParams.get(param);
        if (value && /^\d+$/.test(value)) {
            return {
                guestId: `profile:id:${value}`,
                canonicalUrl,
                rawUrl,
                sourceType: `query-${param}`,
            };
        }
    }

    return null;
}

function parseFacebookUrl(rawUrl) {
    try {
        const cleanUrl = normalizeFacebookUrl(rawUrl);
        if (!cleanUrl) {
            return null;
        }

        return buildFacebookIdentity(cleanUrl, rawUrl);
    } catch (error) {
        return null;
    }
}

function extractFacebookLinks(text) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    const matches = extractUrlCandidates(text);
    const results = [];
    const seen = new Set();

    for (const rawUrl of matches) {
        const parsed = parseFacebookUrl(rawUrl);
        if (!parsed || seen.has(parsed.guestId)) {
            continue;
        }

        seen.add(parsed.guestId);
        results.push(parsed);
    }

    return results;
}

function extractFacebookID(text) {
    const links = extractFacebookLinks(text);
    return links.length > 0 ? links[0].guestId : null;
}

function analyzeFacebookUrl(rawUrl) {
    try {
        const cleanUrl = normalizeFacebookUrl(rawUrl);
        if (!cleanUrl) {
            return {
                valid: false,
                rawUrl,
                reason: 'non-facebook',
            };
        }

        const identity = buildFacebookIdentity(cleanUrl, rawUrl);
        if (!identity) {
            return {
                valid: false,
                rawUrl,
                reason: 'unrecognized-facebook-link',
            };
        }

        return {
            valid: true,
            rawUrl,
            guestId: identity.guestId,
            canonicalUrl: identity.canonicalUrl,
            sourceType: identity.sourceType,
        };
    } catch (error) {
        return {
            valid: false,
            rawUrl,
            reason: 'invalid-url',
        };
    }
}

module.exports = { extractFacebookID, extractFacebookLinks, parseFacebookUrl, extractUrlCandidates, analyzeFacebookUrl, normalizeFacebookUrl };