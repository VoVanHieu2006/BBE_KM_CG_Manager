const { saveOrUpdateRole, incrementInviteCount, markAsDoNotInvite, batchProcessActions } = require('../repositories/sheetRepository');
const { callSendAPI } = require('./facebookSender');
const { pendingBatches, pendingSingleLinks, cachedGuestLookup } = require('../store/inMemoryStore');
const { formatBatchAnalysis } = require('./messageHandler');
const { resolveShareLink } = require('./resolveLinkService');

async function handleQuickReply(sender_psid, payload, memberName) {
    const parts = payload.split('|');
    const type = parts[0];

    if (type === 'ROLE') {
        const roleName = decodeURIComponent(parts[1] || 'Khách mời');
        const linkRefId = parts[2];
        const pending = pendingSingleLinks.get(linkRefId);

        if (!pending || pending.sender_psid !== sender_psid) {
            callSendAPI(sender_psid, { "text": "⚠️ Dữ liệu link đã hết hạn, bạn gửi lại link nhé!" });
            return;
        }

        let guestId = pending.guestId;
        let url = pending.canonicalUrl;

        // Fallback: nếu guestId vẫn là share:hash (resolve thất bại trước đó), thử lại từ cache
        if (guestId.startsWith('share:') && pending.rawUrl) {
            const reResolved = await resolveShareLink(pending.rawUrl).catch(() => null);
            if (reResolved && reResolved.guestId && !reResolved.guestId.startsWith('share:')) {
                guestId = reResolved.guestId;
                url = reResolved.originalLink;
            }
        }

        if (roleName === 'BO_QUA') {
            pendingSingleLinks.delete(linkRefId);
            callSendAPI(sender_psid, { "text": "⏭️ Đã bỏ qua thao tác. Dữ liệu giữ nguyên trạng thái cũ." });
            return;
        }

        try {
            const result = await saveOrUpdateRole(guestId, url, memberName, roleName);
            


            let response = {
                "text": `📊 Hệ thống ghi nhận: ${roleName}.\n👉 Người này đã được mời: ${result.inviteCount} lần.\n\nBạn muốn làm gì tiếp theo?`,
                "quick_replies": [
                    { "content_type": "text", "title": "💌 Mời", "payload": `ACTION|MOI|${encodeURIComponent(roleName)}|${linkRefId}` },
                    { "content_type": "text", "title": "🚫 Không mời lại", "payload": `ACTION|KHONG_MOI|${encodeURIComponent(roleName)}|${linkRefId}` },
                    { "content_type": "text", "title": "⏩ Bỏ qua", "payload": `ACTION|BO_QUA|${encodeURIComponent(roleName)}|${linkRefId}` }
                ]
            };
            callSendAPI(sender_psid, response);
        } catch (e) { console.error(e); }
    }

    else if (type === 'ACTION') {
        const actionName = parts[1];
        const roleName = decodeURIComponent(parts[2] || 'Khách mời');
        const linkRefId = parts[3];
        const pending = pendingSingleLinks.get(linkRefId);

        if (!pending || pending.sender_psid !== sender_psid) {
            callSendAPI(sender_psid, { "text": "⚠️ Dữ liệu link đã hết hạn, bạn gửi lại link nhé!" });
            return;
        }

        const guestId = pending.guestId;

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

        pendingSingleLinks.delete(linkRefId);
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
            const rawValidLinks = batch.items.filter(item => item.valid);

            // Re-resolve các share link từ cache trước khi lưu (không gọi HTTP nếu đã cache)
            const validLinks = await Promise.all(rawValidLinks.map(async (item) => {
                if (!item.guestId.startsWith('share:')) {
                    return { guestId: item.guestId, originalLink: item.canonicalUrl };
                }
                const resolved = await resolveShareLink(item.canonicalUrl).catch(() => null);
                if (resolved && resolved.guestId && !resolved.guestId.startsWith('share:')) {
                    return { guestId: resolved.guestId, originalLink: resolved.originalLink };
                }
                return { guestId: item.guestId, originalLink: item.canonicalUrl };
            }));

            if (validLinks.length > 0) {
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

module.exports = { handleQuickReply };
