require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { extractFacebookID, extractFacebookLinks, parseFacebookUrl, extractUrlCandidates, analyzeFacebookUrl } = require('./utils/linkParser');
// ĐÃ SỬA: Thêm batchProcessActions vào đây
const { getGuestRow, findGuestRowAcrossRoles, loadGuestLookupAcrossRoles, saveOrUpdateRole, incrementInviteCount, markAsDoNotInvite, batchProcessActions } = require('./repositories/sheetRepository');

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const EVENT_TTL_MS = 10 * 60 * 1000;
const BATCH_TTL_MS = 15 * 60 * 1000;
const BATCH_DETAIL_PREVIEW_LIMIT = 7;
const BATCH_HISTORY_BUTTON_THRESHOLD = 8;

const MAX_MESSAGE_LENGTH = 600; 
const GUEST_LOOKUP_TTL_MS = 5 * 60 * 1000; 

const processedMessageIds = new Map();
const pendingBatches = new Map();

const cachedGuestLookup = { data: null, timestamp: 0 };

app.get('/ping', (req, res) => {
    res.status(200).send('Server is awake!');
});

app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];
    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    let body = req.body;
    if (body.object === 'page') {
        body.entry.forEach(function(entry) {
            (entry.messaging || []).forEach(function(webhook_event) {
                const sender_psid = webhook_event.sender && webhook_event.sender.id;
                const memberName = "Thành viên BBE";

                if (!sender_psid) return;

                const messageId = webhook_event.message && webhook_event.message.mid;
                if (messageId && wasMessageProcessed(messageId)) return;

                if (webhook_event.message && webhook_event.message.quick_reply) {
                    let payload = webhook_event.message.quick_reply.payload;
                    handleQuickReply(sender_psid, payload, memberName).catch(error => console.error(error));
                    return;
                }

                if (webhook_event.message) {
                    const extractedLinks = collectIncomingLinks(webhook_event.message);

                    if (extractedLinks.length === 1) {
                        handleMessage(sender_psid, extractedLinks[0], memberName).catch(error => console.error(error));
                    } else if (extractedLinks.length > 1) {
                        handleBatchMessage(sender_psid, extractedLinks, memberName).catch(error => console.error(error));
                    } else {
                        callSendAPI(sender_psid, { "text": "🤖 Vui lòng gửi Link Facebook cá nhân nhé, mình không hiểu định dạng này." });
                    }
                }
            });
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

async function handleMessage(sender_psid, parsedLink, memberName) {
    const linkData = typeof parsedLink === 'string' ? parseFacebookUrl(parsedLink) : parsedLink;
    if (!linkData || !linkData.guestId) {
        callSendAPI(sender_psid, { "text": "🤖 Link không đúng định dạng Facebook profile rồi bạn ơi!" });
        return;
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

function collectIncomingLinks(message) {
    const collectedRawUrls = [];

    if (message.text) {
        const textLinks = extractUrlCandidates(message.text);
        textLinks.forEach(rawUrl => {
            collectedRawUrls.push({ rawUrl, source: 'text' });
        });
    }

    if (Array.isArray(message.attachments)) {
        message.attachments.forEach(attachment => {
            const candidateUrl = attachment && attachment.payload && attachment.payload.url;
            if (!candidateUrl) return;
            collectedRawUrls.push({ rawUrl: candidateUrl, source: attachment.type || 'attachment' });
        });
    }

    const parsedLinks = collectedRawUrls
        .map(item => parseFacebookUrl(item.rawUrl))
        .filter(Boolean);

    const nonShareLinks = parsedLinks.filter(link => link.sourceType !== 'share');
    const shareLinks = parsedLinks.filter(link => link.sourceType === 'share');

    const preferredLinks = (parsedLinks.length === 2 && nonShareLinks.length === 1 && shareLinks.length === 1)
        ? nonShareLinks
        : parsedLinks;

    const seenGuestIds = new Set();
    return preferredLinks.filter(link => {
        if (seenGuestIds.has(link.guestId)) return false;
        seenGuestIds.add(link.guestId);
        return true;
    });
}

function wasMessageProcessed(messageId) {
    cleanupTimedStore(processedMessageIds, EVENT_TTL_MS);
    if (processedMessageIds.has(messageId)) return true;
    processedMessageIds.set(messageId, Date.now());
    return false;
}

function cleanupTimedStore(store, ttlMs) {
    const cutoff = Date.now() - ttlMs;
    for (const [key, timestamp] of store.entries()) {
        if (timestamp < cutoff) store.delete(key);
    }
}

function cleanupPendingBatches() {
    const cutoff = Date.now() - BATCH_TTL_MS;
    for (const [batchId, batch] of pendingBatches.entries()) {
        if (batch.createdAt < cutoff) pendingBatches.delete(batchId);
    }
}

function storePendingBatch(sender_psid, links) {
    cleanupPendingBatches();

    const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    pendingBatches.set(batchId, {
        sender_psid,
        items: links,
        showHistoryShortcut: links.length >= BATCH_HISTORY_BUTTON_THRESHOLD,
        createdAt: Date.now(),
    });

    return batchId;
}

async function getCachedGuestLookup() {
    const now = Date.now();
    if (cachedGuestLookup.data && now - cachedGuestLookup.timestamp < GUEST_LOOKUP_TTL_MS) {
        return cachedGuestLookup.data;
    }
    cachedGuestLookup.data = await loadGuestLookupAcrossRoles();
    cachedGuestLookup.timestamp = now;
    return cachedGuestLookup.data;
}

async function handleBatchMessage(sender_psid, incomingLinks, memberName) {
    const validLinks = incomingLinks.filter(link => link);

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

        if (seenGuestIds.has(analyzed.guestId)) {
            summary.duplicateCount += 1;
            items.push({
                rawUrl: link.rawUrl,
                valid: false,
                reason: 'duplicate-in-list',
                guestId: analyzed.guestId,
                canonicalUrl: analyzed.canonicalUrl,
                inviteCount: 0,
                status: 'Trùng trong list',
            });
            continue;
        }

        seenGuestIds.add(analyzed.guestId);
        summary.validCount += 1;

        const existing = existingLookup.get(analyzed.guestId);
        const inviteCount = existing ? parseInt(existing.row.get('So_Lan_Moi') || 0) : 0;
        const currentStatus = existing ? existing.row.get('Trang_Thai') || 'Đang khởi tạo' : 'Chưa có trong sheet';

        items.push({
            rawUrl: link.rawUrl,
            valid: true,
            guestId: analyzed.guestId,
            canonicalUrl: analyzed.canonicalUrl,
            sourceType: analyzed.sourceType,
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

function sendRoleSelection(sender_psid, linkData) {
    let response = {
        "text": "🎯 Khách này hợp lệ. Vui lòng chọn phân loại:",
        "quick_replies": [
            { "content_type": "text", "title": "👤 Khách Mời", "payload": `ROLE|${encodeURIComponent('Khách mời')}|${encodeURIComponent(linkData.guestId)}|${encodeURIComponent(linkData.canonicalUrl)}` },
            { "content_type": "text", "title": "🎓 Chuyên Gia", "payload": `ROLE|${encodeURIComponent('Chuyên gia')}|${encodeURIComponent(linkData.guestId)}|${encodeURIComponent(linkData.canonicalUrl)}` },
            { "content_type": "text", "title": "⏭️ Bỏ qua", "payload": `ROLE|${encodeURIComponent('BO_QUA')}|${encodeURIComponent(linkData.guestId)}|${encodeURIComponent(linkData.canonicalUrl)}` }
        ]
    };
    callSendAPI(sender_psid, response);
}

async function handleQuickReply(sender_psid, payload, memberName) {
    const parts = payload.split('|');
    const type = parts[0];

    if (type === 'ROLE') {
        const roleName = decodeURIComponent(parts[1] || 'Khách mời');
        const guestId = decodeURIComponent(parts[2] || '');
        const url = decodeURIComponent(parts[3] || '');

        if (roleName === 'BO_QUA') {
            callSendAPI(sender_psid, { "text": "⏭️ Đã bỏ qua thao tác. Dữ liệu giữ nguyên trạng thái cũ." });
            return;
        }

        try {
            const result = await saveOrUpdateRole(guestId, url, memberName, roleName);
            let response = {
                "text": `📊 Hệ thống ghi nhận: ${roleName}.\n👉 Người này đã được mời: ${result.inviteCount} lần.\n\nBạn muốn làm gì tiếp theo?`,
                "quick_replies": [
                    { "content_type": "text", "title": "💌 Mời", "payload": `ACTION|MOI|${encodeURIComponent(roleName)}|${encodeURIComponent(guestId)}` },
                    { "content_type": "text", "title": "🚫 Không mời lại", "payload": `ACTION|KHONG_MOI|${encodeURIComponent(roleName)}|${encodeURIComponent(guestId)}` },
                    { "content_type": "text", "title": "⏩ Bỏ qua", "payload": `ACTION|BO_QUA|${encodeURIComponent(roleName)}|${encodeURIComponent(guestId)}` }
                ]
            };
            callSendAPI(sender_psid, response);
        } catch (e) { console.error(e); }
    }

    else if (type === 'ACTION') {
        const actionName = parts[1];
        const hasNewPayloadShape = parts.length >= 4;
        const roleName = hasNewPayloadShape ? decodeURIComponent(parts[2] || 'Khách mời') : 'Khách mời';
        const guestId = hasNewPayloadShape ? decodeURIComponent(parts[3] || '') : decodeURIComponent(parts[2] || '');
        try {
            if (actionName === 'MOI') {
                const newCount = await incrementInviteCount(guestId, roleName);
                callSendAPI(sender_psid, { "text": `✅ Đã ghi nhận 1 lượt tiếp cận! Tổng số lần mời hiện tại: ${newCount} lần.` });
            } else if (actionName === 'KHONG_MOI') {
                await markAsDoNotInvite(guestId, roleName);
                callSendAPI(sender_psid, { "text": "🚫 Đã chuyển trạng thái thành [Không mời lại]. Hệ thống sẽ phát cảnh báo đỏ nếu có ai gửi lại link này." });
            } else if (actionName === 'BO_QUA') {
                callSendAPI(sender_psid, { "text": "⏩ Đã hủy thao tác. Dữ liệu giữ nguyên trạng thái cũ." });
            }
        } catch (e) { console.error(e); }
    }

    else if (type === 'BATCH_ROLE') {
        const roleName = decodeURIComponent(parts[1] || 'Khách mời');
        const batchId = parts[2];
        const batch = pendingBatches.get(batchId);

        if (!batch || batch.sender_psid !== sender_psid) {
            callSendAPI(sender_psid, { "text": "⚠️ Danh sách link tạm đã hết hạn hoặc không hợp lệ. Vui lòng gửi lại list." });
            return;
        }

        if (roleName === 'BO_QUA') {
            pendingBatches.delete(batchId);
            callSendAPI(sender_psid, { "text": "⏭️ Đã bỏ qua list này. Dữ liệu giữ nguyên trạng thái cũ." });
            return;
        }

        if (roleName === 'VIEW_HISTORY') {
            const detailText = formatBatchAnalysis(batch.items, 30); 
            callSendAPI(sender_psid, {
                "text": `${detailText}\n\nChọn cách xử lý tiếp theo cho list này:`,
                "quick_replies": [
                    { "content_type": "text", "title": "👤 Khách Mời", "payload": `BATCH_ROLE|${encodeURIComponent('Khách mời')}|${batchId}` },
                    { "content_type": "text", "title": "🎓 Chuyên Gia", "payload": `BATCH_ROLE|${encodeURIComponent('Chuyên gia')}|${batchId}` },
                    { "content_type": "text", "title": "⏩ Bỏ qua", "payload": `BATCH_ROLE|${encodeURIComponent('BO_QUA')}|${batchId}` }
                ]
            });
            return;
        }

        batch.selectedRole = roleName;

        const actionReplies = [
            { "content_type": "text", "title": "💌 Mời", "payload": `BATCH_ACTION|MOI|${encodeURIComponent(roleName)}|${batchId}` },
            { "content_type": "text", "title": "🚫 Không mời lại", "payload": `BATCH_ACTION|KHONG_MOI|${encodeURIComponent(roleName)}|${batchId}` }
        ];

        if (batch.showHistoryShortcut) {
            actionReplies.push({ "content_type": "text", "title": "📜 Xem lịch sử mời", "payload": `BATCH_ACTION|VIEW_HISTORY|${encodeURIComponent(roleName)}|${batchId}` });
        }

        actionReplies.push({ "content_type": "text", "title": "⏩ Bỏ qua", "payload": `BATCH_ACTION|BO_QUA|${encodeURIComponent(roleName)}|${batchId}` });

        callSendAPI(sender_psid, {
            "text": `📊 Hệ thống ghi nhận list này là [${roleName}].\n👉 Danh sách có ${batch.items.length} link.\n\nBạn muốn làm gì tiếp theo?`,
            "quick_replies": actionReplies
        });
    }

    else if (type === 'BATCH_ACTION') {
        const actionName = parts[1];
        const roleName = decodeURIComponent(parts[2] || 'Khách mời');
        const batchId = parts[3];
        const batch = pendingBatches.get(batchId);

        if (!batch || batch.sender_psid !== sender_psid) {
            callSendAPI(sender_psid, { "text": "⚠️ Danh sách link tạm đã hết hạn hoặc không hợp lệ. Vui lòng gửi lại list." });
            return;
        }

        if (actionName === 'VIEW_HISTORY') {
            const detailText = formatBatchAnalysis(batch.items, 30); 
            callSendAPI(sender_psid, {
                "text": `${detailText}\n\nChọn cách xử lý tiếp theo cho list [${roleName}]:`,
                "quick_replies": [
                    { "content_type": "text", "title": "💌 Mời", "payload": `BATCH_ACTION|MOI|${encodeURIComponent(roleName)}|${batchId}` },
                    { "content_type": "text", "title": "🚫 Không mời lại", "payload": `BATCH_ACTION|KHONG_MOI|${encodeURIComponent(roleName)}|${batchId}` },
                    { "content_type": "text", "title": "⏩ Bỏ qua", "payload": `BATCH_ACTION|BO_QUA|${encodeURIComponent(roleName)}|${batchId}` }
                ]
            });
            return;
        }

        pendingBatches.delete(batchId);

        if (actionName === 'BO_QUA') {
            callSendAPI(sender_psid, { "text": "⏭️ Đã bỏ qua list này. Dữ liệu giữ nguyên trạng thái cũ." });
            return;
        }

        const results = { created: 0, updated: 0, invited: 0, doNotInvite: 0, failed: 0 };

        try {
            const validLinks = batch.items.filter(item => item.valid).map(item => ({
                guestId: item.guestId,
                originalLink: item.canonicalUrl
            }));

            if (validLinks.length > 0) {
                // ĐÃ CHẠY ĐƯỢC: Vì batchProcessActions đã được import ở đầu file
                const batchResult = await batchProcessActions(validLinks, roleName, memberName, actionName);
                results.created = batchResult.created;
                results.updated = batchResult.updated;
                
                if (actionName === 'MOI') {
                    results.invited = validLinks.length;
                } else if (actionName === 'KHONG_MOI') {
                    results.doNotInvite = validLinks.length;
                }
            }
        } catch (error) {
            results.failed = batch.items.filter(item => item.valid).length;
            console.error('Lỗi khi xử lý batch:', error);
        }

        callSendAPI(sender_psid, {
            "text": actionName === 'MOI'
                ? `✅ Đã xử lý list ${batch.items.length} link cho nhóm [${roleName}].\n- Mới thêm: ${results.created}\n- Cập nhật trùng: ${results.updated}\n- Đã mời: ${results.invited}\n- Lỗi: ${results.failed}`
                : `✅ Đã xử lý list ${batch.items.length} link cho nhóm [${roleName}].\n- Mới thêm: ${results.created}\n- Cập nhật trùng: ${results.updated}\n- Đã chuyển [Không mời lại]: ${results.doNotInvite}\n- Lỗi: ${results.failed}`
        });
    }
}

async function callSendAPI(sender_psid, response) {
    const text = response.text || '';

    if (text.length > MAX_MESSAGE_LENGTH) {
        const chunks = splitMessageIntoChunks(text, MAX_MESSAGE_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
            const chunkMsg = { ...response, text: chunks[i] };
            if (i < chunks.length - 1) {
                delete chunkMsg.quick_replies; 
            }
            await sendSingleMessage(sender_psid, chunkMsg);
        }
    } else {
        await sendSingleMessage(sender_psid, response);
    }
}

function splitMessageIntoChunks(text, maxLength) {
    const chunks = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        if (splitAt === -1 || splitAt < maxLength * 0.8) {
            splitAt = maxLength;
        }
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trim();
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}

async function sendSingleMessage(sender_psid, response) {
    let request_body = { "recipient": { "id": sender_psid }, "message": response };
    try {
        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, request_body);
    } catch (err) {
        console.error('Lỗi API Facebook:', err.response ? err.response.data : err.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BBE Bot API đang chạy mượt mà trên Localhost, port ${PORT}`));