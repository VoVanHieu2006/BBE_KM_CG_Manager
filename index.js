require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { extractFacebookID } = require('./utils/linkParser');
const { getGuestRow, saveOrUpdateRole, incrementInviteCount, markAsDoNotInvite } = require('./repositories/sheetRepository');

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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
            let webhook_event = entry.messaging[0];
            let sender_psid = webhook_event.sender.id;
            let memberName = "Thành viên BBE"; 

            // TẦNG 2: XỬ LÝ KHI THÀNH VIÊN BẤM NÚT LỰA CHỌN
            if (webhook_event.message && webhook_event.message.quick_reply) {
                let payload = webhook_event.message.quick_reply.payload;
                handleQuickReply(sender_psid, payload, memberName);
            } 
            // TẦNG 1: XỬ LÝ KHI THÀNH VIÊN GỬI LINK HOẶC BẤM NÚT SHARE TỪ APP
            else if (webhook_event.message) {
                let extractedLink = null;

                // 1. Nếu gửi bằng text (Copy & Paste)
                if (webhook_event.message.text) {
                    extractedLink = webhook_event.message.text;
                }
                // 2. Nếu gửi bằng nút Share từ điện thoại (Attachment)
                else if (webhook_event.message.attachments) {
                    let attachment = webhook_event.message.attachments[0];
                    // Link Share thường nằm trong payload.url
                    if (attachment.payload && attachment.payload.url) {
                        extractedLink = attachment.payload.url;
                    }
                }

                // Nếu moi được link ra thì mang đi xử lý
                if (extractedLink) {
                    handleMessage(sender_psid, extractedLink);
                } else {
                    // Nếu gửi ảnh, sticker... thì báo lỗi
                    callSendAPI(sender_psid, { "text": "🤖 Vui lòng gửi Link Facebook cá nhân nhé, mình không hiểu định dạng này." });
                }
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// --- HÀM XỬ LÝ LƯỢT 1: NHẬN LINK ---
async function handleMessage(sender_psid, text) {
    const guestId = extractFacebookID(text);
    if (!guestId) {
        callSendAPI(sender_psid, { "text": "🤖 Link không đúng định dạng Facebook profile rồi bạn ơi!" });
        return;
    }

    try {
        const row = await getGuestRow(guestId);
        
        // KIỂM TRA CẢNH BÁO ĐỎ TRƯỚC TIÊN
        if (row && row.get('Trang_Thai') === 'Không mời lại') {
            callSendAPI(sender_psid, { 
                "text": `⚠️ CẢNH BÁO ĐỎ: Người này đã bị đánh dấu [KHÔNG MỜI LẠI]! Vui lòng không tiếp cận.` 
            });
            return;
        }

        // Nếu bình thường, hiển thị lựa chọn phân loại dữ liệu ban đầu
        sendRoleSelection(sender_psid, guestId, text);
    } catch (error) {
        console.error(error);
    }
}

// --- GỬI NÚT CHỌN PHÂN LOẠI (TẦNG 1) ---
function sendRoleSelection(sender_psid, guestId, url) {
    let response = {
        "text": "🎯 Khách này hợp lệ. Vui lòng chọn phân loại:",
        "quick_replies": [
            { "content_type": "text", "title": "👤 Khách Mời", "payload": `ROLE|Khách mời|${guestId}|${url}` },
            { "content_type": "text", "title": "🎓 Chuyên Gia", "payload": `ROLE|Chuyên gia|${guestId}|${url}` }
        ]
    };
    callSendAPI(sender_psid, response);
}

// --- HÀM XỬ LÝ LƯỢT 2: KHI BẤM NÚT ---
async function handleQuickReply(sender_psid, payload, memberName) {
    const parts = payload.split('|');
    const type = parts[0]; // ROLE hoặc ACTION

    if (type === 'ROLE') {
        const [_, roleName, guestId, url] = parts;
        try {
            // Lưu phân loại xuống sheet và lấy số lần mời hiện tại
            const currentInvites = await saveOrUpdateRole(guestId, url, memberName, roleName);
            
            // Gửi tiếp Tầng nút bấm thứ 2: Hỏi hành động xử lý tiếp theo
            let response = {
                "text": `📊 Hệ thống ghi nhận: ${roleName}.\n👉 Người này đã được mời: ${currentInvites} lần.\n\nBạn muốn làm gì tiếp theo?`,
                "quick_replies": [
                    { "content_type": "text", "title": "💌 Mời", "payload": `ACTION|MOI|${guestId}` },
                    { "content_type": "text", "title": "🚫 Không mời lại", "payload": `ACTION|KHONG_MOI|${guestId}` },
                    { "content_type": "text", "title": "⏩ Bỏ qua", "payload": `ACTION|BO_QUA|${guestId}` }
                ]
            };
            callSendAPI(sender_psid, response);
        } catch (e) { console.error(e); }
    } 
    
    else if (type === 'ACTION') {
        const [_, actionName, guestId] = parts;
        try {
            if (actionName === 'MOI') {
                const newCount = await incrementInviteCount(guestId);
                callSendAPI(sender_psid, { "text": `✅ Đã ghi nhận 1 lượt tiếp cận! Tổng số lần mời hiện tại: ${newCount} lần.` });
            } else if (actionName === 'KHONG_MOI') {
                await markAsDoNotInvite(guestId);
                callSendAPI(sender_psid, { "text": "🚫 Đã chuyển trạng thái thành [Không mời lại]. Hệ thống sẽ phát cảnh báo đỏ nếu có ai gửi lại link này." });
            } else if (actionName === 'BO_QUA') {
                callSendAPI(sender_psid, { "text": "⏩ Đã hủy thao tác. Dữ liệu giữ nguyên trạng thái cũ." });
            }
        } catch (e) { console.error(e); }
    }
}

function callSendAPI(sender_psid, response) {
    let request_body = { "recipient": { "id": sender_psid }, "message": response };
    axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, request_body)
        .catch(err => console.error('Lỗi API Facebook:', err.response ? err.response.data : err.message));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BBE Bot API đang chạy mượt mà trên Localhost, port ${PORT}`));