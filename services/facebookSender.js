const axios = require('axios');
const { PAGE_ACCESS_TOKEN, MAX_MESSAGE_LENGTH } = require('../config');

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

module.exports = { callSendAPI, sendSingleMessage, splitMessageIntoChunks };
