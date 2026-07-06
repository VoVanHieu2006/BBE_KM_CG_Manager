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

        // Trích xuất numeric ID từ meta tag fb://profile/<id> trong HTML
        let numericId = null;
        const html = response.data;
        if (typeof html === 'string') {
            const fbProfileMatch = html.match(/fb:\/\/profile\/(\d+)/i);
            if (fbProfileMatch && fbProfileMatch[1]) {
                numericId = fbProfileMatch[1];
            }
        }

        const parsed = parseFacebookUrl(finalUrl);

        // Ưu tiên 1: username (ổn định nhất)
        if (parsed && parsed.guestId && parsed.sourceType === 'profile-username') {
            const result = {
                originalLink: parsed.canonicalUrl,
                guestId: parsed.guestId,
                sourceType: parsed.sourceType,
                resolvedFrom: rawUrl,
            };
            memCache.set(cacheKey, result);
            setShareCache(cacheKey, result.originalLink, result.guestId).catch(() => {});
            return result;
        }

        // Ưu tiên 2: numeric ID từ HTML (cho tài khoản không có username)
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

        // Ưu tiên 3: bất kỳ identity hợp lệ nào khác (profile-id, query-profile_id, people-id...)
        if (parsed && parsed.guestId && !parsed.sourceType.startsWith('share') && !parsed.sourceType.startsWith('share-') && !parsed.needsResolve) {
            const result = {
                originalLink: parsed.canonicalUrl,
                guestId: parsed.guestId,
                sourceType: parsed.sourceType,
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

module.exports = { resolveShareLink, resolveAllShareLinks };
