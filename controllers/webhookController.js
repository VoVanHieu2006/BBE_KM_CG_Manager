const { VERIFY_TOKEN } = require('../config');
const { wasMessageProcessed, pendingSingleLinks, pendingBatches, cachedGuestLookup } = require('../store/inMemoryStore');
const { collectIncomingLinks, handleMessage, handleBatchMessage } = require('../services/messageHandler');
const { handleQuickReply } = require('../services/quickReplyHandler');
const { callSendAPI } = require('../services/facebookSender');

function getWebhook(req, res) {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];
    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
}

// Nhận diện vai trò từ văn bản thuần túy (fallback cho các dòng máy bị lỗi mất quick reply payload)
function detectRoleFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.toLowerCase().trim();
    if (clean.includes('khách mời') || clean.includes('khach moi')) return 'Khách mời';
    if (clean.includes('chuyên gia') || clean.includes('chuyen gia')) return 'Chuyên gia';
    if (clean.includes('bỏ qua') || clean.includes('bo qua')) return 'BO_QUA';
    return null;
}

// Nhận diện hành động tiếp theo từ văn bản thuần túy
function detectActionFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.toLowerCase().trim();
    if (clean === 'mời' || clean === 'moi' || clean === '💌 mời') return 'MOI';
    if (clean.includes('không mời') || clean.includes('khong moi') || clean.includes('🚫')) return 'KHONG_MOI';
    if (clean.includes('bỏ qua') || clean.includes('bo qua') || clean.includes('⏩')) return 'BO_QUA';
    return null;
}

// Xử lý fallback cho nút chọn Vai trò (ROLE / BATCH_ROLE)
async function handleTextRoleFallback(sender_psid, role, memberName) {
    let latestLink = null;
    let latestLinkTime = 0;
    let latestLinkRefId = null;
    for (const [refId, data] of pendingSingleLinks.entries()) {
        if (data.sender_psid === sender_psid && data.createdAt > latestLinkTime) {
            latestLink = data;
            latestLinkRefId = refId;
            latestLinkTime = data.createdAt;
        }
    }

    let latestBatch = null;
    let latestBatchTime = 0;
    let latestBatchId = null;
    for (const [batchId, data] of pendingBatches.entries()) {
        if (data.sender_psid === sender_psid && data.createdAt > latestBatchTime) {
            latestBatch = data;
            latestBatchId = batchId;
            latestBatchTime = data.createdAt;
        }
    }

    if (latestLink && (!latestBatch || latestLinkTime >= latestBatchTime)) {
        const payload = `ROLE|${encodeURIComponent(role)}|${latestLinkRefId}`;
        await handleQuickReply(sender_psid, payload, memberName);
        return true;
    } else if (latestBatch) {
        const payload = `BATCH_ROLE|${encodeURIComponent(role)}|${latestBatchId}`;
        await handleQuickReply(sender_psid, payload, memberName);
        return true;
    }
    return false;
}

// Xử lý fallback cho nút hành động (ACTION / BATCH_ACTION)
async function handleTextActionFallback(sender_psid, action, memberName) {
    let latestLink = null;
    let latestLinkTime = 0;
    let latestLinkRefId = null;
    for (const [refId, data] of pendingSingleLinks.entries()) {
        if (data.sender_psid === sender_psid && data.createdAt > latestLinkTime) {
            latestLink = data;
            latestLinkRefId = refId;
            latestLinkTime = data.createdAt;
        }
    }

    let latestBatch = null;
    let latestBatchTime = 0;
    let latestBatchId = null;
    for (const [batchId, data] of pendingBatches.entries()) {
        if (data.sender_psid === sender_psid && data.createdAt > latestBatchTime) {
            latestBatch = data;
            latestBatchId = batchId;
            latestBatchTime = data.createdAt;
        }
    }

    if (latestLink && (!latestBatch || latestLinkTime >= latestBatchTime)) {
        let roleName = 'Khách mời';
        if (cachedGuestLookup.data) {
            const guest = cachedGuestLookup.data.get(latestLink.guestId);
            if (guest && guest.sheetTitle === 'ChuyenGia') {
                roleName = 'Chuyên gia';
            }
        }
        const payload = `ACTION|${action}|${encodeURIComponent(roleName)}|${latestLinkRefId}`;
        await handleQuickReply(sender_psid, payload, memberName);
        return true;
    } else if (latestBatch) {
        const roleName = latestBatch.selectedRole || 'Khách mời';
        const payload = `BATCH_ACTION|${action}|${encodeURIComponent(roleName)}|${latestBatchId}`;
        await handleQuickReply(sender_psid, payload, memberName);
        return true;
    }
    return false;
}

function postWebhook(req, res) {
    let body = req.body;
    if (body.object === 'page') {
        body.entry.forEach(function(entry) {
            (entry.messaging || []).forEach(async function(webhook_event) {
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
                    const text = webhook_event.message.text;

                    if (text && text.toLowerCase().trim() === '/sync') {
                        const { syncCacheFromSheets } = require('../store/inMemoryStore');
                        callSendAPI(sender_psid, { "text": "🔄 Đang đồng bộ lại dữ liệu từ Google Sheets..." });
                        syncCacheFromSheets()
                            .then(() => {
                                callSendAPI(sender_psid, { "text": "✅ Đồng bộ thành công! RAM và tệp cache cục bộ đã được cập nhật mới nhất." });
                            })
                            .catch(err => {
                                console.error('Lỗi sync:', err);
                                callSendAPI(sender_psid, { "text": `❌ Đồng bộ thất bại: ${err.message}` });
                            });
                        return;
                    }

                    // Fallback thông minh: Dịch tin nhắn chữ thường thành hành động Quick Reply 
                    // khi giao diện Messenger của Facebook bị lỗi không gửi kèm payload
                    const detectedRole = detectRoleFromText(text);
                    if (detectedRole) {
                        const success = await handleTextRoleFallback(sender_psid, detectedRole, memberName).catch(() => false);
                        if (success) return;
                    }

                    const detectedAction = detectActionFromText(text);
                    if (detectedAction) {
                        const success = await handleTextActionFallback(sender_psid, detectedAction, memberName).catch(() => false);
                        if (success) return;
                    }

                    const extractedLinks = collectIncomingLinks(webhook_event.message);

                    if (extractedLinks.length === 1) {
                        handleMessage(sender_psid, extractedLinks[0], memberName).catch(error => console.error(error));
                    } else if (extractedLinks.length > 1) {
                        handleBatchMessage(sender_psid, extractedLinks, memberName).catch(error => console.error(error));
                    } else {
                        const textHadUrlLookingContent = /https?:\/\//.test(webhook_event.message.text || '');
                        const feedbackText = textHadUrlLookingContent
                            ? "🤖 Mình thấy có link nhưng không nhận diện được đây là link Facebook cá nhân hợp lệ. Bạn kiểm tra lại link hoặc gửi link khác nhé!"
                            : "🤖 Vui lòng gửi Link Facebook cá nhân nhé, mình không hiểu định dạng này.";
                        callSendAPI(sender_psid, { "text": feedbackText });
                    }
                }
            });
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
}

module.exports = { getWebhook, postWebhook };
