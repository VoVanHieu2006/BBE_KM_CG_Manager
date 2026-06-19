const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

async function initSheet() {
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc.sheetsByIndex[0]; 
}

// Lấy thông tin khách mời nếu đã tồn tại
async function getGuestRow(guestId) {
    const sheet = await initSheet();
    const rows = await sheet.getRows();
    return rows.find(row => row.get('ID_Khach') === guestId);
}

// Khởi tạo hoặc cập nhật phân loại (Khách mời/Chuyên gia)
async function saveOrUpdateRole(guestId, originalLink, memberName, role) {
    const sheet = await initSheet();
    const rows = await sheet.getRows();
    const existingGuest = rows.find(row => row.get('ID_Khach') === guestId);

    if (existingGuest) {
        existingGuest.set('Phan_Loai', role);
        existingGuest.set('Nguoi_Moi', memberName);
        await existingGuest.save();
        return parseInt(existingGuest.get('So_Lan_Moi') || 0);
    } else {
        await sheet.addRow({
            ID_Khach: guestId,
            Link_Goc: originalLink,
            Nguoi_Moi: memberName,
            Trang_Thai: 'Đang khởi tạo',
            Phan_Loai: role,
            So_Lan_Moi: '0'
        });
        return 0;
    }
}

// Hành động: Mời (Cộng dồn số lần)
async function incrementInviteCount(guestId) {
    const row = await getGuestRow(guestId);
    if (row) {
        const currentCount = parseInt(row.get('So_Lan_Moi') || 0);
        row.set('So_Lan_Moi', (currentCount + 1).toString());
        row.set('Trang_Thai', 'Đang liên hệ');
        await row.save();
        return currentCount + 1;
    }
    return 0;
}

// Hành động: Đánh dấu không mời lại
async function markAsDoNotInvite(guestId) {
    const row = await getGuestRow(guestId);
    if (row) {
        row.set('Trang_Thai', 'Không mời lại');
        await row.save();
    }
}

module.exports = { getGuestRow, saveOrUpdateRole, incrementInviteCount, markAsDoNotInvite };