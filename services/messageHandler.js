const { parseFacebookUrl, extractUrlCandidates, analyzeFacebookUrl } = require('../utils/linkParser');
const { findGuestRowAcrossRoles } = require('../repositories/sheetRepository');
const { callSendAPI } = require('./facebookSender');
const { getCachedGuestLookup, storePendingBatch, pendingBatches, pendingSingleLinks, cleanupTimedStoreByField } = require('../store/inMemoryStore');
const { BATCH_DETAIL_PREVIEW_LIMIT, BATCH_HISTORY_BUTTON_THRESHOLD, EVENT_TTL_MS } = require('../config');
const { resolveShareLink, resolveAllShareLinks } = require('./resolveLinkService');

function collectIncomingLinks(message) {
    const collectedRawUrls = [];

    const textCandidates = message.text ? extractUrlCandidates(message.text) : [];
    textCandidates.forEach(rawUrl => {
        collectedRawUrls.push({ rawUrl, source: 'text' });
    });

    if (Array.isArray(message.attachments)) {
        message.attachments.forEach(attachment => {
            const candidateUrl = attachment && attachment.payload && attachment.payload.url;
            if (!candidateUrl) return;
            collectedRawUrls.push({ rawUrl: candidateUrl, source: attachment.type || 'attachment' });
        });
    }

    const parsedItems = collectedRawUrls
        .map(item => ({ item, parsed: parseFacebookUrl(item.rawUrl) }))
        .filter(x => Boolean(x.parsed));

    const textOnlyParsed = parsedItems.filter(x => x.item.source === 'text').map(x => x.parsed);
    const hasTextCandidates = textCandidates.length > 0;
    const workingSet = hasTextCandidates
        ? textOnlyParsed
        : parsedItems.map(x => x.parsed);

    const nonShareLinks = workingSet.filter(link => link.sourceType !== 'share' && link.sourceType !== 'share-fbme');
    const shareLinks = workingSet.filter(link => link.sourceType === 'share' || link.sourceType === 'share-fbme');

    const preferredLinks = (workingSet.length === 2 && nonShareLinks.length === 1 && shareLinks.length === 1)
        ? nonShareLinks
        : workingSet;

    const seenGuestIds = new Set();
    return preferredLinks.filter(link => {
        if (seenGuestIds.has(link.guestId)) return false;
        seenGuestIds.add(link.guestId);
        return true;
    });
}

async function handleMessage(sender_psid, parsedLink, memberName) {
    const linkData = typeof parsedLink === 'string' ? parseFacebookUrl(parsedLink) : parsedLink;
    if (!linkData || !linkData.guestId) {
        callSendAPI(sender_psid, { "text": "🤖 Link không đúng định dạng Facebook profile rồi bạn ơi!" });
        return;
    }

    if (linkData.needsResolve) {
        const resolved = await resolveShareLink(linkData.rawUrl);
        if (resolved && resolved.guestId && !resolved.guestId.startsWith('share:')) {
            linkData.guestId = resolved.guestId;
            linkData.canonicalUrl = resolved.originalLink;
            linkData.sourceType = `resolved-${resolved.sourceType || linkData.sourceType}`;
        }
    }

    try {
        const rowInfo = await findGuestRowAcrossRoles(linkData.guestId);

        if (rowInfo && rowInfo.row.get('Trang_Thai') === 'Không mời lại') {
            callSendAPI(sender_psid, {
                "text": `⚠️ CẢNH BÁO ĐỎ: Người này đã bị đánh dấu [KHÔNG MỜI LẠI]! Vui lòng không tiếp cận.`
            });
            return;
        }

        sendRoleSelection(sender_psid, linkData);
    } catch (error) {
        console.error(error);
    }
}

function sendRoleSelection(sender_psid, linkData) {
    cleanupTimedStoreByField(pendingSingleLinks, EVENT_TTL_MS, 'createdAt');

    const linkRefId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    pendingSingleLinks.set(linkRefId, {
        guestId: linkData.guestId,
        canonicalUrl: linkData.canonicalUrl,
        sender_psid,
        createdAt: Date.now(),
    });

    let response = {
        "text": "🎯 Khách này hợp lệ. Vui lòng chọn phân loại:",
        "quick_replies": [
            { "content_type": "text", "title": "👤 Khách Mời", "payload": `ROLE|${encodeURIComponent('Khách mời')}|${linkRefId}` },
            { "content_type": "text", "title": "🎓 Chuyên Gia", "payload": `ROLE|${encodeURIComponent('Chuyên gia')}|${linkRefId}` },
            { "content_type": "text", "title": "⏭️ Bỏ qua", "payload": `ROLE|${encodeURIComponent('BO_QUA')}|${linkRefId}` }
        ]
    };
    callSendAPI(sender_psid, response);
}

async function handleBatchMessage(sender_psid, incomingLinks, memberName) {
    let validLinks = incomingLinks.filter(link => link);

    validLinks = await resolveAllShareLinks(validLinks);

    if (validLinks.length > 30) {
        callSendAPI(sender_psid, {
            "text": `⚠️ Danh sách quá lớn (${validLinks.length} link). Hãy chia thành các list nhỏ tầm 15-20 link để bot xử lý mượt mà và an toàn nhất nhé.`
        });
    }

    const analysis = await buildBatchAnalysis(validLinks);
    const batchId = storePendingBatch(sender_psid, analysis.items);
    const batch = pendingBatches.get(batchId);

    if (batch) batch.summary = analysis.summary;

    const summaryLines = formatBatchAnalysis(analysis.items, BATCH_DETAIL_PREVIEW_LIMIT);
    const hasManyLinks = analysis.items.length > BATCH_DETAIL_PREVIEW_LIMIT;
    const shouldShowHistoryShortcut = analysis.items.length >= BATCH_HISTORY_BUTTON_THRESHOLD;

    if (batch) batch.showHistoryShortcut = shouldShowHistoryShortcut;

    let response = {
        "text": hasManyLinks
            ? `📦 Đã phân tích ${analysis.items.length} link.\n- Hợp lệ: ${analysis.summary.validCount}\n- Không hợp lệ: ${analysis.summary.invalidCount}\n- Trùng trong list: ${analysis.summary.duplicateCount}\n\nBấm "Xem lịch sử mời" nếu muốn xem chi tiết từng link.`
            : `📦 Đã phân tích ${analysis.items.length} link.\n${summaryLines}\n\nChọn phân loại áp dụng cho toàn bộ danh sách:`,
        "quick_replies": [
            { "content_type": "text", "title": `👤 Khách Mời (${analysis.items.length})`, "payload": `BATCH_ROLE|${encodeURIComponent('Khách mời')}|${batchId}` },
            { "content_type": "text", "title": `🎓 Chuyên Gia (${analysis.items.length})`, "payload": `BATCH_ROLE|${encodeURIComponent('Chuyên gia')}|${batchId}` },
            { "content_type": "text", "title": `⏭️ Bỏ qua (${analysis.items.length})`, "payload": `BATCH_ROLE|${encodeURIComponent('BO_QUA')}|${batchId}` }
        ]
    };

    if (shouldShowHistoryShortcut) {
        response.quick_replies.splice(2, 0, { "content_type": "text", "title": "📜 Xem lịch sử mời", "payload": `BATCH_ROLE|${encodeURIComponent('VIEW_HISTORY')}|${batchId}` });
    }

    callSendAPI(sender_psid, response);
}

async function buildBatchAnalysis(incomingLinks) {
    const items = [];
    const summary = { validCount: 0, invalidCount: 0, duplicateCount: 0 };
    const seenGuestIds = new Set();
    const existingLookup = await getCachedGuestLookup();

    for (const link of incomingLinks) {
        let guestId, canonicalUrl, sourceType;

        if (link.resolvedFromShare) {
            guestId = link.guestId;
            canonicalUrl = link.canonicalUrl;
            sourceType = link.sourceType;
        } else {
            const analyzed = analyzeFacebookUrl(link.rawUrl);

            if (!analyzed || !analyzed.valid) {
                summary.invalidCount += 1;
                items.push({
                    rawUrl: link.rawUrl,
                    valid: false,
                    reason: analyzed ? analyzed.reason : 'invalid-url',
                    inviteCount: 0,
                    status: 'Không hợp lệ',
                });
                continue;
            }

            guestId = analyzed.guestId;
            canonicalUrl = analyzed.canonicalUrl;
            sourceType = analyzed.sourceType;
        }

        if (seenGuestIds.has(guestId)) {
            summary.duplicateCount += 1;
            items.push({
                rawUrl: link.rawUrl,
                valid: false,
                reason: 'duplicate-in-list',
                guestId,
                canonicalUrl,
                inviteCount: 0,
                status: 'Trùng trong list',
            });
            continue;
        }

        seenGuestIds.add(guestId);
        summary.validCount += 1;

        const existing = existingLookup.get(guestId);
        const inviteCount = existing ? parseInt(existing.row.get('So_Lan_Moi') || 0) : 0;
        const currentStatus = existing ? existing.row.get('Trang_Thai') || 'Đang khởi tạo' : 'Chưa có trong sheet';

        items.push({
            rawUrl: link.rawUrl,
            valid: true,
            guestId,
            canonicalUrl,
            sourceType,
            inviteCount,
            status: currentStatus,
            sheetTitle: existing ? existing.sheetTitle : null,
        });
    }

    return { items, summary };
}

function formatBatchAnalysis(items, limit) {
    const lines = [];
    const slice = items.slice(0, limit);

    for (const item of slice) {
        if (item.valid) {
            lines.push(`✅ ${item.canonicalUrl} | mời: ${item.inviteCount} | trạng thái: ${item.status}`);
        } else {
            lines.push(`❌ ${item.rawUrl} | ${describeInvalidReason(item.reason)}`);
        }
    }

    if (items.length > limit) {
        lines.push(`... và ${items.length - limit} link nữa`);
    }

    return lines.join('\n');
}

function describeInvalidReason(reason) {
    if (reason === 'non-facebook') return 'ngoài Facebook';
    if (reason === 'duplicate-in-list') return 'trùng trong list';
    if (reason === 'unrecognized-facebook-link') return 'không nhận diện được link';
    return 'không hợp lệ';
}

module.exports = {
    collectIncomingLinks,
    handleMessage,
    handleBatchMessage,
    buildBatchAnalysis,
    formatBatchAnalysis,
    describeInvalidReason,
    sendRoleSelection,
};
