const { VERIFY_TOKEN } = require('../config');
const { wasMessageProcessed } = require('../store/inMemoryStore');
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

function postWebhook(req, res) {
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
