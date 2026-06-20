require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { extractFacebookID, extractFacebookLinks, parseFacebookUrl } = require('./utils/linkParser');
const { getGuestRow, findGuestRowAcrossRoles, saveOrUpdateRole, incrementInviteCount, markAsDoNotInvite } = require('./repositories/sheetRepository');

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const EVENT_TTL_MS = 10 * 60 * 1000;
const BATCH_TTL_MS = 15 * 60 * 1000;

const processedMessageIds = new Map();
const pendingBatches = new Map();

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
                    handleQuickReply(sender_psid, payload, memberName);
                    return;
                }

                // TẦNG 1: XỬ LÝ KHI THÀNH VIÊN GỬI LINK HOẶC BẤM NÚT SHARE TỪ APP
                if (webhook_event.message) {
                    const extractedLinks = extractIncomingLinks(webhook_event.message);

                    if (extractedLinks.length === 1) {
                        handleMessage(sender_psid, extractedLinks[0], memberName);
                    } else if (extractedLinks.length > 1) {
                        handleBatchMessage(sender_psid, extractedLinks, memberName);
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

function extractIncomingLinks(message) {
    const collectedLinks = [];
    const seenGuestIds = new Set();

    if (message.text) {
        const textLinks = extractFacebookLinks(message.text);
        textLinks.forEach(link => {
            if (!seenGuestIds.has(link.guestId)) {
                seenGuestIds.add(link.guestId);
                collectedLinks.push(link);
            }
        });
    }

    if (Array.isArray(message.attachments)) {
        message.attachments.forEach(attachment => {
            const candidateUrl = attachment && attachment.payload && attachment.payload.url;
            if (!candidateUrl) {
                return;
            }

            const parsedLink = parseFacebookUrl(candidateUrl);
            if (!parsedLink || seenGuestIds.has(parsedLink.guestId)) {
                return;
            }

            seenGuestIds.add(parsedLink.guestId);
            collectedLinks.push(parsedLink);
        });
    }

    return collectedLinks;
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
        links,
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

async function handleBatchMessage(sender_psid, links, memberName) {
    const batchId = storePendingBatch(sender_psid, links);
    let response = {
        "text": `📦 Phát hiện ${links.length} link Facebook hợp lệ. Chọn phân loại áp dụng cho toàn bộ danh sách:`,
        "quick_replies": [
            { "content_type": "text", "title": `👤 Khách Mời (${links.length})`, "payload": `BATCH_ROLE|${encodeURIComponent('Khách mời')}|${batchId}` },
            { "content_type": "text", "title": `🎓 Chuyên Gia (${links.length})`, "payload": `BATCH_ROLE|${encodeURIComponent('Chuyên gia')}|${batchId}` },
            { "content_type": "text", "title": `⏭️ Bỏ qua (${links.length})`, "payload": `BATCH_ROLE|${encodeURIComponent('BO_QUA')}|${batchId}` }
        ]
    };

    callSendAPI(sender_psid, response);
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

        batch.selectedRole = roleName;

        callSendAPI(sender_psid, {
            "text": `📊 Hệ thống ghi nhận list này là [${roleName}].\n👉 Danh sách có ${batch.links.length} link hợp lệ.\n\nBạn muốn làm gì tiếp theo?`,
            "quick_replies": [
                { "content_type": "text", "title": "💌 Mời", "payload": `BATCH_ACTION|MOI|${encodeURIComponent(roleName)}|${batchId}` },
                { "content_type": "text", "title": "🚫 Không mời lại", "payload": `BATCH_ACTION|KHONG_MOI|${encodeURIComponent(roleName)}|${batchId}` },
                { "content_type": "text", "title": "⏩ Bỏ qua", "payload": `BATCH_ACTION|BO_QUA|${encodeURIComponent(roleName)}|${batchId}` }
            ]
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

        pendingBatches.delete(batchId);

        if (actionName === 'BO_QUA') {
            callSendAPI(sender_psid, { "text": "⏭️ Đã bỏ qua list này. Dữ liệu giữ nguyên trạng thái cũ." });
            return;
        }

        const results = { created: 0, updated: 0, invited: 0, doNotInvite: 0, failed: 0 };

        for (const link of batch.links) {
            try {
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
        }

        callSendAPI(sender_psid, {
            "text": actionName === 'MOI'
                ? `✅ Đã xử lý list ${batch.links.length} link cho nhóm [${roleName}].\n- Mới thêm: ${results.created}\n- Cập nhật trùng: ${results.updated}\n- Đã mời: ${results.invited}\n- Lỗi: ${results.failed}`
                : `✅ Đã xử lý list ${batch.links.length} link cho nhóm [${roleName}].\n- Mới thêm: ${results.created}\n- Cập nhật trùng: ${results.updated}\n- Đã chuyển [Không mời lại]: ${results.doNotInvite}\n- Lỗi: ${results.failed}`
        });
    }
}

function callSendAPI(sender_psid, response) {
    let request_body = { "recipient": { "id": sender_psid }, "message": response };
    axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, request_body)
        .catch(err => console.error('Lỗi API Facebook:', err.response ? err.response.data : err.message));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BBE Bot API đang chạy mượt mà trên Localhost, port ${PORT}`));