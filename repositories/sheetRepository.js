const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

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
    const rows = await sheet.getRows({ offset: 0 }); 
    
    const lookup = new Map();

    for (const row of rows) {
        const guestId = row.get('ID_Khach');
        if (!guestId) {
            continue;
        }
        lookup.set(guestId, row);
    }

    return { sheet, rows, lookup };
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
    // TỐI ƯU CỐT LÕI: Đọc song song cả lookup tổng để chống trùng và chống lag đồng bộ
    const { sheet, lookup: roleLookup } = await loadRoleRows(role);
    const crossLookup = await loadGuestLookupAcrossRoles(); 

    const rowsToAdd = [];
    const requests = []; 
    const sheetId = sheet.sheetId;

    for (const { guestId, originalLink } of links) {
        // Ưu tiên lấy từ roleLookup, nếu không có thì kiểm tra chéo ở crossLookup
        let existing = roleLookup.get(guestId);
        if (!existing && crossLookup.has(guestId)) {
            const crossItem = crossLookup.get(guestId);
            // Nếu khách đã nằm đúng sheet role này rồi thì lấy row đó luôn
            if (crossItem.sheetTitle === resolveSheetTitle(role)) {
                existing = crossItem.row;
            }
        }
        
        let newInviteCount = '1';
        let newStatus = 'Đang liên hệ';
        
        if (actionName === 'KHONG_MOI') {
            newStatus = 'Không mời lại';
            newInviteCount = '0'; 
        }

        if (existing) {
            // Ép kiểu an toàn tuyệt đối
            let currentCount = parseInt(String(existing.get('So_Lan_Moi')).trim(), 10);
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

            const rowIndex = parseInt(existing.rowIndex, 10) - 1;
            if (isNaN(rowIndex) || rowIndex < 1) continue; // Bảo vệ hàng header

            requests.push({
                updateCells: {
                    start: { sheetId: sheetId, rowIndex: rowIndex, columnIndex: 2 }, 
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
            // Nếu thực sự chưa có thì mới thêm mới
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
    batchProcessActions, // Export thêm hàm mới
};


