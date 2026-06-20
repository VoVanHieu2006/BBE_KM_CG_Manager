require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { extractFacebookID, extractFacebookLinks, parseFacebookUrl, extractUrlCandidates, analyzeFacebookUrl } = require('./utils/linkParser');
const { getGuestRow, findGuestRowAcrossRoles, loadGuestLookupAcrossRoles, saveOrUpdateRole, incrementInviteCount, markAsDoNotInvite } = require('./repositories/sheetRepository');

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const EVENT_TTL_MS = 10 * 60 * 1000;
const BATCH_TTL_MS = 15 * 60 * 1000;
const BATCH_DETAIL_PREVIEW_LIMIT = 7;
const BATCH_HISTORY_BUTTON_THRESHOLD = 8;

// Hằng số mới cho giới hạn
const MAX_MESSAGE_LENGTH = 600; // Facebook API giới hạn ~640 chars
const API_DELAY_MS = 200; // Delay giữa các API calls
const GUEST_LOOKUP_TTL_MS = 5 * 60 * 1000; // Cache 5 phút

const processedMessageIds = new Map();
const pendingBatches = new Map();

// Cache cho guest lookup
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

                if (!sender_psid) {
                    return;
                }

                const messageId = webhook_event.message && webhook_event.message.mid;
                if (messageId && wasMessageProcessed(messageId)) {
                    return;
                }

                // TẦNG 2: XỬ LÝ KHI THÀNH VIÊN BẤM NÚT LỰA CHỌN
                if (webhook_event.message && webhook_event.message.quick_reply) {
                    let payload = webhook_event.message.quick_reply.payload;
                    handleQuickReply(sender_psid, payload, memberName).catch(error => console.error(error));
                    return;
                }

                // TẦNG 1: XỬ LÝ KHI THÀNH VIÊN GỬI LINK HOẶC BẤM NÚT SHARE TỪ APP
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

// --- HÀM XỬ LÝ LƯỢT 1: NHẬN LINK ---
async function handleMessage(sender_psid, parsedLink, memberName) {
    const linkData = typeof parsedLink === 'string' ? parseFacebookUrl(parsedLink) : parsedLink;
    if (!linkData || !linkData.guestId) {
        callSendAPI(sender_psid, { "text": "🤖 Link không đúng định dạng Facebook profile rồi bạn ơi!" });
        return;
    }

    try {
        const rowInfo = await findGuestRowAcrossRoles(linkData.guestId);
        
        // KIỂM TRA CẢNH BÁO ĐỎ TRƯỚC TIÊN
        if (rowInfo && rowInfo.row.get('Trang_Thai') === 'Không mời lại') {
            callSendAPI(sender_psid, { 
                "text": `⚠️ CẢNH BÁO ĐỎ: Người này đã bị đánh dấu [KHÔNG MỜI LẠI]! Vui lòng không tiếp cận.` 
            });
            return;
        }

        // Nếu bình thường, hiển thị lựa chọn phân loại dữ liệu ban đầu
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
            if (!candidateUrl) {
                return;
            }

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
        if (seenGuestIds.has(link.guestId)) {
            return false;
        }

        seenGuestIds.add(link.guestId);
        return true;
    });
}

function wasMessageProcessed(messageId) {
    cleanupTimedStore(processedMessageIds, EVENT_TTL_MS);

    if (processedMessageIds.has(messageId)) {
        return true;
    }

    processedMessageIds.set(messageId, Date.now());
    return false;
}

function cleanupTimedStore(store, ttlMs) {
    const cutoff = Date.now() - ttlMs;
    for (const [key, timestamp] of store.entries()) {
        if (timestamp < cutoff) {
            store.delete(key);
        }
    }
}

function cleanupPendingBatches() {
    const cutoff = Date.now() - BATCH_TTL_MS;
    for (const [batchId, batch] of pendingBatches.entries()) {
        if (batch.createdAt < cutoff) {
            pendingBatches.delete(batchId);
        }
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

    setTimeout(() => {
        const batch = pendingBatches.get(batchId);
        if (batch && Date.now() - batch.createdAt >= BATCH_TTL_MS) {
            pendingBatches.delete(batchId);
        }
    }, BATCH_TTL_MS);

    return batchId;
}

// Cache lookup guests - tối ưu tìm kiếm
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

    // CẢNH BÁO KHI QUÁ NHIỀU LINK
    if (validLinks.length > 30) {
            callSendAPI(sender_psid, {
            "text": `⚠️ Danh sách quá lớn (${validLinks.length} link). Facebook API có thể không xử lý hết. Bạn nên chia thành nhiều batch nhỏ hơn (15-20 link/batch) để đảm bảo ổn định.`
        });
    }

    const analysis = await buildBatchAnalysis(validLinks);
    const batchId = storePendingBatch(sender_psid, analysis.items);
        const batch = pendingBatches.get(batchId);

    if (batch) {
        batch.summary = analysis.summary;
        }

    const summaryLines = formatBatchAnalysis(analysis.items, BATCH_DETAIL_PREVIEW_LIMIT);
    const hasManyLinks = analysis.items.length > BATCH_DETAIL_PREVIEW_LIMIT;
    const shouldShowHistoryShortcut = analysis.items.length >= BATCH_HISTORY_BUTTON_THRESHOLD;
    if (batch) {
        batch.showHistoryShortcut = shouldShowHistoryShortcut;
    }

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
    const existingLookup = await getCachedGuestLookup(); // Dùng cache

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

// Format batch analysis với giới hạn ký tự
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
    if (reason === 'non-facebook') {
        return 'ngoài Facebook';
    }

    if (reason === 'duplicate-in-list') {
        return 'trùng trong list';
    }

    if (reason === 'unrecognized-facebook-link') {
        return 'không nhận diện được link';
    }

    return 'không hợp lệ';
}

// --- GỬI NÚT CHỌN PHÂN LOẠI (TẦNG 1) ---
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

// --- HÀM XỬ LÝ LƯỢT 2: KHI BẤM NÚT ---
async function handleQuickReply(sender_psid, payload, memberName) {
    const parts = payload.split('|');
    const type = parts[0]; // ROLE, ACTION, BATCH_ROLE hoặc BATCH_ACTION

    if (type === 'ROLE') {
        const roleName = decodeURIComponent(parts[1] || 'Khách mời');
        const guestId = decodeURIComponent(parts[2] || '');
        const url = decodeURIComponent(parts[3] || '');

        if (roleName === 'BO_QUA') {
            callSendAPI(sender_psid, { "text": "⏭️ Đã bỏ qua thao tác. Dữ liệu giữ nguyên trạng thái cũ." });
            return;
        }

        try {
            // Lưu phân loại xuống sheet và lấy số lần mời hiện tại
            const result = await saveOrUpdateRole(guestId, url, memberName, roleName);

            // Gửi tiếp Tầng nút bấm thứ 2: Hỏi hành động xử lý tiếp theo
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
            // Xử lý xem lịch sử với giới hạn ký tự
            const detailText = formatBatchAnalysis(batch.items, 30); // Giới hạn 30 thay vì 50
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
            callSendAPI(sender_psid, { "text": "⚠️ Danh sách link tạm đã hết hạn hoặc không hợp lệ. Vui lllllà gửi lại list." });
            return;
        }

        if (actionName === 'VIEW_HISTORY') {
            const detailText = formatBatchAnalysis(batch.items, 30); // Giới hạn 30
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

        // Xử lý batch với delay để tránh rate limit
        for (let i = 0; i < batch.items.length; i++) {
            const link = batch.items[i];
            try {
                if (!link.valid) {
                    continue;
                }

                const saveResult = await saveOrUpdateRole(link.guestId, link.canonicalUrl, memberName, roleName);
                if (saveResult.status === 'created') {
                    results.created += 1;
                } else if (saveResult.status === 'updated') {
                    results.updated += 1;
                }

                if (actionName === 'MOI') {
                    const newCount = await incrementInviteCount(link.guestId, roleName);
                    if (newCount > 0) {
                        results.invited += 1;
                    }
                } else if (actionName === 'KHONG_MOI') {
                    await markAsDoNotInvite(link.guestId, roleName);
                    results.doNotInvite += 1;
                }
            } catch (error) {
                results.failed += 1;
                console.error(error);
            }

            // Delay giữa các hành động để tránh rate limit
            if (i < batch.items.length - 1) {
                await sleep(API_DELAY_MS);
        }
        }

        callSendAPI(sender_psid, {
            "text": actionName === 'MOI'
                ? `✅ Đã xử lý list ${batch.items.length} link cho nhóm [${roleName}].\n- Mới thêm: ${results.created}\n- Cập nhật trùng: ${results.updated}\n- Đã mời: ${results.invited}\n- Lỗi: ${results.failed}`
                : `✅ Đã xử lý list ${batch.items.length} link cho nhóm [${roleName}].\n- Mới thêm: ${results.created}\n- Cập nhật trùng: ${results.updated}\n- Đã chuyển [Không mời lại]: ${results.doNotInvite}\n- Lỗi: ${results.failed}`
        });
    }
}

// Hàm delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Gửi tin nhắn có giới hạn - chia nhỏ nếu quá dài
async function callSendAPI(sender_psid, response) {
    const text = response.text || '';

    if (text.length > MAX_MESSAGE_LENGTH) {
        // Chia thành nhiều tin nhắn
        const chunks = splitMessageIntoChunks(text, MAX_MESSAGE_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
            const chunkMsg = { ...response, text: chunks[i] };
            if (i < chunks.length - 1) {
                delete chunkMsg.quick_replies; // Chỉ giữ quick_replies ở tin cuối
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