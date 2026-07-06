const axios = require('axios');
const { getShareCache, setShareCache } = require('../repositories/sheetRepository');
const { parseFacebookUrl } = require('../utils/linkParser');

const memCache = new Map();
let lastRequestTime = 0;
const THROTTLE_MS = 800;          // Giảm từ 2500ms → 800ms
const BATCH_CONCURRENCY = 3;      // Số link share xử lý song song

// ============================================================
// Normalize cache key: chỉ dùng phần share code ổn định,
// bỏ các tham số biến đổi như mibextid, wtsid, rdid
// VD: "https://www.facebook.com/share/1JaXnESwkn/?mibextid=wwXIfr"
//     → "facebook.com/share/1JaXnESwkn"
// ============================================================
function normalizeCacheKey(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const shareMatch = url.pathname.match(/^\/share\/([a-zA-Z0-9_-]+)/);
        if (shareMatch) {
            return `facebook.com/share/${shareMatch[1]}`;
        }
        if (url.hostname === 'fb.me' || url.hostname.endsWith('.fb.me')) {
            const fbmeMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)$/);
            if (fbmeMatch) return `fb.me/${fbmeMatch[1]}`;
        }
    } catch (e) {}
    return rawUrl; // fallback: dùng nguyên nếu không match
}

async function throttleDelay() {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < THROTTLE_MS) {
        await new Promise(resolve => setTimeout(resolve, THROTTLE_MS - elapsed));
    }
    lastRequestTime = Date.now();
}

async function resolveShareLink(rawUrl) {
    const cacheKey = normalizeCacheKey(rawUrl);

    // Kiểm tra in-memory cache (key chuẩn hóa)
    if (memCache.has(cacheKey)) return memCache.get(cacheKey);

    // Kiểm tra Google Sheet cache (key chuẩn hóa)
    const cached = await getShareCache(cacheKey).catch(() => null);
    if (cached && cached.guestId) {
        memCache.set(cacheKey, cached);
        return cached;
    }

    let currentUrl = rawUrl;
    let redirectCount = 0;
    const maxRedirects = 5;
    let lastProfileParsed = null;
    let htmlContent = null;

    try {
        await throttleDelay();
        
        while (redirectCount < maxRedirects) {
            const response = await axios.get(currentUrl, {
                maxRedirects: 0,
                headers: {
                    'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_codedoc.html)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                validateStatus: (status) => status >= 200 && status < 400,
                timeout: 8000,
            });

            if (response.status >= 300 && response.status < 400 && response.headers.location) {
                const nextUrl = response.headers.location;
                
                // Parse URL redirect tiếp theo
                const parsedNext = parseFacebookUrl(nextUrl);
                if (parsedNext && parsedNext.guestId) {
                    // Nếu bị redirect sang trang login/checkpoint của FB, dừng redirect chain
                    if (nextUrl.includes('/login') || nextUrl.includes('/checkpoint') || nextUrl.includes('/cookie/consent')) {
                        break;
                    }
                    
                    if (!parsedNext.sourceType.startsWith('share') && !parsedNext.sourceType.startsWith('share-')) {
                        lastProfileParsed = parsedNext;
                        
                        // Nếu là profile-username hoặc profile-id (không cần resolve tiếp), trả về ngay lập tức để tránh gọi HTTP body
                        if (!parsedNext.needsResolve) {
                            const result = {
                                originalLink: parsedNext.canonicalUrl,
                                guestId: parsedNext.guestId,
                                sourceType: parsedNext.sourceType,
                                resolvedFrom: rawUrl,
                            };
                            memCache.set(cacheKey, result);
                            setShareCache(cacheKey, result.originalLink, result.guestId).catch(() => {});
                            return result;
                        }
                    }
                }

                currentUrl = nextUrl;
                redirectCount++;
            } else {
                // Status 200 OK
                htmlContent = response.data;
                const parsedFinal = parseFacebookUrl(currentUrl);
                if (parsedFinal && !parsedFinal.sourceType.startsWith('share') && !parsedFinal.sourceType.startsWith('share-')) {
                    lastProfileParsed = parsedFinal;
                }
                break;
            }
        }

        // Trích xuất numeric ID từ HTML nếu tải được HTML body
        let numericId = null;
        if (typeof htmlContent === 'string') {
            const fbProfileMatch = htmlContent.match(/fb:\/\/profile\/(\d+)/i);
            if (fbProfileMatch && fbProfileMatch[1]) {
                numericId = fbProfileMatch[1];
            }
        }

        if (numericId) {
            const result = {
                originalLink: `https://facebook.com/profile.php?id=${numericId}`,
                guestId: `profile:id:${numericId}`,
                sourceType: 'profile-id',
                resolvedFrom: rawUrl,
            };
            memCache.set(cacheKey, result);
            setShareCache(cacheKey, result.originalLink, result.guestId).catch(() => {});
            return result;
        }

        // Fallback dùng profile cuối cùng parse được trong redirect chain
        if (lastProfileParsed) {
            const result = {
                originalLink: lastProfileParsed.canonicalUrl,
                guestId: lastProfileParsed.guestId,
                sourceType: lastProfileParsed.sourceType,
                resolvedFrom: rawUrl,
            };
            memCache.set(cacheKey, result);
            setShareCache(cacheKey, result.originalLink, result.guestId).catch(() => {});
            return result;
        }
    } catch (e) {
        // silent fail — không crash bot
    }


    return null;
}

// ============================================================
// Xử lý song song: tối đa BATCH_CONCURRENCY link cùng lúc
// thay vì xử lý tuần tự từng link một
// ============================================================
async function resolveAllShareLinks(links) {
    const result = new Array(links.length);

    // Tách riêng link cần resolve và link bình thường
    const shareIndices = [];
    links.forEach((link, i) => {
        if (link.needsResolve) shareIndices.push(i);
        else result[i] = link;
    });

    // Xử lý song song theo nhóm BATCH_CONCURRENCY
    for (let i = 0; i < shareIndices.length; i += BATCH_CONCURRENCY) {
        const batch = shareIndices.slice(i, i + BATCH_CONCURRENCY);
        const resolved = await Promise.all(
            batch.map(idx => resolveShareLink(links[idx].rawUrl))
        );

        resolved.forEach((res, j) => {
            const idx = batch[j];
            const link = links[idx];
            if (res && res.guestId) {
                result[idx] = {
                    ...link,
                    guestId: res.guestId,
                    canonicalUrl: res.originalLink,
                    sourceType: `resolved-${res.sourceType || link.sourceType}`,
                    rawUrl: link.rawUrl,
                    resolvedFromShare: true,
                };
            } else {
                result[idx] = link;
            }
        });
    }

    return result;
}

async function getResolvedLinkFromCache(rawUrl) {
    const cacheKey = normalizeCacheKey(rawUrl);
    if (memCache.has(cacheKey)) return memCache.get(cacheKey);
    const cached = await getShareCache(cacheKey).catch(() => null);
    if (cached && cached.guestId) {
        memCache.set(cacheKey, cached);
        return cached;
    }
    return null;
}

module.exports = { resolveShareLink, resolveAllShareLinks, getResolvedLinkFromCache };

