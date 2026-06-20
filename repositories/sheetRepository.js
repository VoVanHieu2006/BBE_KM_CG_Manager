const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const ROLE_SHEETS = {
    'Khách mời': 'KhachMoi',
    'Chuyên gia': 'ChuyenGia',
};

const SHEET_HEADERS = ['ID_Khach', 'Link_Goc', 'Nguoi_Moi', 'Trang_Thai', 'Phan_Loai', 'So_Lan_Moi'];

async function initSheet() {
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc;
}

function resolveSheetTitle(role) {
    return ROLE_SHEETS[role] || ROLE_SHEETS['Khách mời'];
}

async function getOrCreateRoleSheet(role) {
    const doc = await initSheet();
    const sheetTitle = resolveSheetTitle(role);
    let sheet = doc.sheetsByTitle[sheetTitle];

    if (!sheet) {
        sheet = await doc.addSheet({ title: sheetTitle, headerValues: SHEET_HEADERS });
    }

    return sheet;
}

// Lấy thông tin khách mời nếu đã tồn tại
async function getGuestRow(guestId, role) {
    const sheet = await getOrCreateRoleSheet(role);
    const rows = await sheet.getRows();
    return rows.find(row => row.get('ID_Khach') === guestId);
}

async function findGuestRowAcrossRoles(guestId) {
    const doc = await initSheet();
    const sheetTitles = Object.values(ROLE_SHEETS);

    for (const sheetTitle of sheetTitles) {
        let sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) {
            continue;
        }

        const rows = await sheet.getRows();
        const row = rows.find(item => item.get('ID_Khach') === guestId);
        if (row) {
            return { row, sheetTitle };
        }
    }

    return null;
}

// Khởi tạo hoặc cập nhật phân loại (Khách mời/Chuyên gia)
async function saveOrUpdateRole(guestId, originalLink, memberName, role) {
    const sheet = await getOrCreateRoleSheet(role);
    const rows = await sheet.getRows();
    const existingGuest = rows.find(row => row.get('ID_Khach') === guestId);

    if (existingGuest) {
        existingGuest.set('Phan_Loai', role);
        existingGuest.set('Nguoi_Moi', memberName);
        existingGuest.set('Link_Goc', originalLink);
        await existingGuest.save();
        return {
            status: 'updated',
            inviteCount: parseInt(existingGuest.get('So_Lan_Moi') || 0),
        };
    } else {
        await sheet.addRow({
            ID_Khach: guestId,
            Link_Goc: originalLink,
            Nguoi_Moi: memberName,
            Trang_Thai: 'Đang khởi tạo',
            Phan_Loai: role,
            So_Lan_Moi: '0'
        });
        return {
            status: 'created',
            inviteCount: 0,
        };
    }
}

// Hành động: Mời (Cộng dồn số lần)
async function incrementInviteCount(guestId, role) {
    const row = await getGuestRow(guestId, role);
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
async function markAsDoNotInvite(guestId, role) {
    const row = await getGuestRow(guestId, role);
    if (row) {
        row.set('Trang_Thai', 'Không mời lại');
        await row.save();
    }
}

module.exports = { getGuestRow, findGuestRowAcrossRoles, saveOrUpdateRole, incrementInviteCount, markAsDoNotInvite, resolveSheetTitle };