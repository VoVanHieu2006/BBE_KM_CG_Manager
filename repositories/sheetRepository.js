const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

const ROLE_SHEETS = {
    'Khách mời': 'KhachMoi',
    'Chuyên gia': 'ChuyenGia',
};

const SHARE_CACHE_SHEET = 'ShareLinkCache';
const SHARE_CACHE_HEADERS = ['Link_Share', 'Link_Goc', 'guestId', 'createdAt'];

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

async function loadGuestLookupAcrossRoles() {
    const doc = await initSheet();
    const sheetTitles = Object.values(ROLE_SHEETS);
    const lookup = new Map();

    for (const sheetTitle of sheetTitles) {
        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) {
            continue;
        }

        const rows = await sheet.getRows({ offset: 0 });
        for (const row of rows) {
            const guestId = row.get('ID_Khach');
            if (!guestId || lookup.has(guestId)) {
                continue;
            }

            lookup.set(guestId, {
                row,
                sheetTitle,
            });
        }
    }

    return lookup;
}

async function loadRoleRows(role) {
    const sheet = await getOrCreateRoleSheet(role);
    const sheetTitle = resolveSheetTitle(role);

    const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Đọc trực tiếp dải ô dữ liệu từ hàng 2 đến hàng 1000 để lấy data mới nhất 100%
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: `${sheetTitle}!A2:F1000`, 
    });

    const rows = response.data.values || [];
    const lookup = new Map();

    // Map dữ liệu dựa trên mảng thuần túy (0: ID_Khach, 1: Link_Goc, 2: Nguoi_Moi, 3: Trang_Thai, 4: Phan_Loai, 5: So_Lan_Moi)
    rows.forEach((row, index) => {
        const guestId = row[0];
        if (!guestId) return;

        lookup.set(guestId, {
            rowIndex: index + 2, // Chuyển về đúng số hàng thực tế trên Sheet (Hàng đầu tiên của data là hàng 2)
            guestId: row[0],
            originalLink: row[1],
            nguoiMoi: row[2],
            trangThai: row[3],
            phanLoai: row[4],
            soLanMoi: row[5] || '0'
        });
    });

    return { sheet, lookup };
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

/**
 * Batch version of saveOrUpdateRole – dùng cho việc xử lý danh sách lớn.
 * Trả về thống kê {created, updated}
 */
async function batchSaveOrUpdate(links, role, memberName) {
    // links: [{guestId, originalLink}]
    const sheet = await getOrCreateRoleSheet(role);
    const existingLookup = await loadGuestLookupAcrossRoles(); // Map<guestId, {row, sheetTitle}>

    const rowsToAdd = [];
    const rowsToUpdate = []; // {rowIndex, values}

    // Google Sheets API works with 0‑based row index within the sheet (excluding header)
    const headerRowCount = 1; // first row is header

    for (const { guestId, originalLink } of links) {
        const existing = existingLookup.get(guestId);
        if (existing && existing.sheetTitle === resolveSheetTitle(role)) {
            // Prepare update – we need the row index of the existing row
            const rowIndex = existing.row.rowIndex - headerRowCount; // rowIndex for API (0‑based after header)
            rowsToUpdate.push({
                rowIndex,
                values: [guestId, originalLink, memberName, 'Đang khởi tạo', role, '0'],
            });
        } else {
            rowsToAdd.push([guestId, originalLink, memberName, 'Đang khởi tạo', role, '0']);
        }
    }

    // Prepare Google Sheets batchUpdate request
    const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const requests = [];

    if (rowsToAdd.length) {
        // Append rows at the end of the sheet
        requests.push({
            appendCells: {
                sheetId: sheet.sheetId,
                rows: rowsToAdd.map(row => ({
                    values: row.map(v => ({ userEnteredValue: { stringValue: v } })),
                })),
                fields: '*',
            },
        });
    }

    rowsToUpdate.forEach(u => {
        requests.push({
            updateCells: {
                start: { sheetId: sheet.sheetId, rowIndex: u.rowIndex, columnIndex: 0 },
                rows: [{
                    values: u.values.map(v => ({ userEnteredValue: { stringValue: v } })),
                }],
                fields: '*',
            },
        });
    });

    if (requests.length === 0) {
        return { created: 0, updated: 0 };
    }

    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.SHEET_ID,
        requestBody: { requests },
    });

    return { created: rowsToAdd.length, updated: rowsToUpdate.length };
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

async function batchMarkDoNotInvite(guestIds, role) {
    if (!Array.isArray(guestIds) || guestIds.length === 0) return { updated: 0 };
    const sheet = await getOrCreateRoleSheet(role);
    const rows = await sheet.getRows();
    const requests = [];
    let updated = 0;
    for (const row of rows) {
        const id = row.get('ID_Khach');
        if (guestIds.includes(id)) {
            const rowIndex = row.rowIndex - 1; // after header
            requests.push({
                updateCells: {
                    start: { sheetId: sheet.sheetId, rowIndex, columnIndex: 3 }, // column 3 = Trang_Thai
                    rows: [{ values: [{ userEnteredValue: { stringValue: 'Không mời lại' } }] }],
                    fields: 'userEnteredValue'
                }
            });
            updated++;
        }
    }
    if (requests.length === 0) return { updated: 0 };
    const { google } = require('googleapis');
    const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.SHEET_ID,
        requestBody: { requests },
    });
    return { updated };
}

// ... (Giữ nguyên các hàm cũ ở trên) ...

/**
 * Xử lý hàng loạt (Batch) cho hành động Mời / Không mời lại
 * Tối ưu hóa bằng Google Sheets batchUpdate để tránh Rate Limit và Timeout
 */
async function batchProcessActions(links, role, memberName, actionName) {
    // Gọi hàm load dữ liệu sạch không qua cache
    const { sheet, lookup } = await loadRoleRows(role);

    const rowsToAdd = [];
    const requests = []; 
    const sheetId = sheet.sheetId;

    for (const { guestId, originalLink } of links) {
        const existing = lookup.get(guestId);
        
        let newInviteCount = '1';
        let newStatus = 'Đang liên hệ';
        
        if (actionName === 'KHONG_MOI') {
            newStatus = 'Không mời lại';
            newInviteCount = '0'; 
        }

        if (existing) {
            // Đọc trực tiếp từ object thuần, không sợ dính bộ nhớ đệm ẩn của thư viện
            let currentCount = parseInt(String(existing.soLanMoi).trim(), 10);
            if (isNaN(currentCount)) {
                currentCount = 0; 
            }

            if (actionName === 'MOI') {
                newInviteCount = (currentCount + 1).toString();
                newStatus = 'Đang liên hệ';
            } else if (actionName === 'KHONG_MOI') {
                newInviteCount = currentCount.toString(); 
                newStatus = 'Không mời lại';
            }

            // existing.rowIndex lúc này đã là số hàng chuẩn 1-based (ví dụ: 2, 3, 4)
            // Cần trừ đi 1 để biến thành 0-based index truyền vào API updateCells
            const apiRowIndex = existing.rowIndex - 1;

            requests.push({
                updateCells: {
                    start: { sheetId: sheetId, rowIndex: apiRowIndex, columnIndex: 2 }, 
                    rows: [{
                        values: [
                            { userEnteredValue: { stringValue: memberName } }, 
                            { userEnteredValue: { stringValue: newStatus } },  
                            { userEnteredValue: { stringValue: role } },       
                            { userEnteredValue: { stringValue: String(newInviteCount) } } 
                        ]
                    }],
                    fields: 'userEnteredValue'
                }
            });
        } else {
            rowsToAdd.push([guestId, originalLink, memberName, newStatus, role, newInviteCount]);
        }
    }

    if (rowsToAdd.length) {
        requests.push({
            appendCells: {
                sheetId: sheetId,
                rows: rowsToAdd.map(row => ({
                    values: row.map(v => ({ userEnteredValue: { stringValue: String(v) } })),
                })),
                fields: '*',
            },
        });
    }

    if (requests.length === 0) {
        return { created: 0, updated: 0 };
    }

    const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.SHEET_ID,
        requestBody: { requests },
    });

    return { created: rowsToAdd.length, updated: requests.length - (rowsToAdd.length ? 1 : 0) };
}

async function getOrCreateShareCacheSheet() {
    const doc = await initSheet();
    let sheet = doc.sheetsByTitle[SHARE_CACHE_SHEET];
    if (!sheet) {
        sheet = await doc.addSheet({ title: SHARE_CACHE_SHEET, headerValues: SHARE_CACHE_HEADERS });
    }
    return sheet;
}

async function getShareCache(shareUrl) {
    try {
        const sheet = await getOrCreateShareCacheSheet();
        const rows = await sheet.getRows();
        const row = rows.find(r => r.get('Link_Share') === shareUrl);
        if (row) {
            return {
                originalLink: row.get('Link_Goc'),
                guestId: row.get('guestId'),
            };
        }
    } catch (e) {
        console.error('getShareCache error:', e.message);
    }
    return null;
}

async function setShareCache(shareUrl, originalLink, guestId) {
    try {
        const sheet = await getOrCreateShareCacheSheet();
        await sheet.addRow({
            Link_Share: shareUrl,
            Link_Goc: originalLink || '',
            guestId: guestId || '',
            createdAt: new Date().toISOString(),
        });
    } catch (e) {
        console.error('setShareCache error:', e.message);
    }
}
module.exports = {
    getGuestRow,
    findGuestRowAcrossRoles,
    loadGuestLookupAcrossRoles,
    loadRoleRows,
    saveOrUpdateRole,
    incrementInviteCount,
    markAsDoNotInvite,
    resolveSheetTitle,
    batchSaveOrUpdate,
    batchMarkDoNotInvite,
    batchProcessActions,
    getShareCache,
    setShareCache,
};


