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

let cachedAuth = null;
let cachedSheets = null;
let cachedDoc = null;

function getSheetsClient() {
    if (cachedSheets) return { auth: cachedAuth, sheets: cachedSheets };
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
    const key = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
    
    cachedAuth = new JWT({
        email,
        key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    cachedSheets = google.sheets({ version: 'v4', auth: cachedAuth });
    return { auth: cachedAuth, sheets: cachedSheets };
}

async function getDoc() {
    if (cachedDoc) return cachedDoc;
    const { auth } = getSheetsClient();
    cachedDoc = new GoogleSpreadsheet(process.env.SHEET_ID, auth);
    await cachedDoc.loadInfo();
    return cachedDoc;
}

async function initSheet() {
    return getDoc();
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

// Tìm kiếm khách hàng trên tất cả vai trò (Dùng cache trong inMemoryStore để có tốc độ tức thời)
async function findGuestRowAcrossRoles(guestId) {
    const { getCachedGuestLookup } = require('../store/inMemoryStore');
    const lookup = await getCachedGuestLookup();
    return lookup.get(guestId) || null;
}

// Đọc danh mục khách hàng từ Google Sheets (Chỉ dùng Sheets API để tải mảng nhẹ, không dùng getRows chậm chạp)
async function loadGuestLookupAcrossRoles() {
    const sheetTitles = Object.values(ROLE_SHEETS);
    const lookup = new Map();

    const { sheets } = getSheetsClient();

    for (const sheetTitle of sheetTitles) {
        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SHEET_ID,
                range: `${sheetTitle}!A2:F`, // Đọc toàn bộ bảng từ dòng 2
            });

            const rows = response.data.values || [];
            rows.forEach((rowData, index) => {
                const guestId = rowData[0];
                if (!guestId || lookup.has(guestId)) return;

                const rowIndex = index + 2; // Số hàng 1-based thực tế trên Sheet
                lookup.set(guestId, {
                    row: {
                        rowIndex,
                        get: (colName) => {
                            const mapping = {
                                'ID_Khach': rowData[0],
                                'Link_Goc': rowData[1],
                                'Nguoi_Moi': rowData[2],
                                'Trang_Thai': rowData[3],
                                'Phan_Loai': rowData[4],
                                'So_Lan_Moi': rowData[5],
                            };
                            return mapping[colName] || '';
                        }
                    },
                    sheetTitle,
                });
            });
        } catch (e) {
            console.error(`Lỗi tải dữ liệu cho sheet ${sheetTitle}:`, e.message);
        }
    }

    return lookup;
}

// Đọc trực tiếp dòng dữ liệu của một phân loại
async function loadRoleRows(role) {
    const sheet = await getOrCreateRoleSheet(role);
    const sheetTitle = resolveSheetTitle(role);

    const { sheets } = getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: `${sheetTitle}!A2:F`, 
    });

    const rows = response.data.values || [];
    const lookup = new Map();

    rows.forEach((row, index) => {
        const guestId = row[0];
        if (!guestId) return;

        lookup.set(guestId, {
            rowIndex: index + 2, 
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

// Khởi tạo hoặc cập nhật phân loại (Khách mời/Chuyên gia) dùng Sheets API tốc độ cao
async function saveOrUpdateRole(guestId, originalLink, memberName, role) {
    const lookup = await loadGuestLookupAcrossRoles();
    const existing = lookup.get(guestId);
    const sheetTitle = resolveSheetTitle(role);

    const { sheets } = getSheetsClient();

    if (existing && existing.sheetTitle === sheetTitle) {
        const rowIndex = existing.row.rowIndex;
        const currentCount = parseInt(existing.row.get('So_Lan_Moi') || 0);

        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SHEET_ID,
            range: `${sheetTitle}!A${rowIndex}:F${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[guestId, originalLink, memberName, existing.row.get('Trang_Thai'), role, String(currentCount)]],
            },
        });

        return {
            status: 'updated',
            inviteCount: currentCount,
        };
    } else {
        if (existing && existing.sheetTitle !== sheetTitle) {
            const oldDoc = await getDoc();
            const oldSheet = oldDoc.sheetsByTitle[existing.sheetTitle];
            if (oldSheet) {
                const oldSheetId = oldSheet.sheetId;
                const oldRowIndex = existing.row.rowIndex;
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: process.env.SHEET_ID,
                    requestBody: {
                        requests: [
                            {
                                deleteDimension: {
                                    range: {
                                        sheetId: oldSheetId,
                                        dimension: 'ROWS',
                                        startIndex: oldRowIndex - 1,
                                        endIndex: oldRowIndex
                                    }
                                }
                            }
                        ]
                    }
                }).catch(err => {
                    console.error(`Error deleting old role row in sheet ${existing.sheetTitle}:`, err);
                });
            }
        }

        const initialStatus = existing ? existing.row.get('Trang_Thai') : 'Đang khởi tạo';
        const initialCount = existing ? parseInt(existing.row.get('So_Lan_Moi') || 0) : 0;

        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SHEET_ID,
            range: `${sheetTitle}!A:F`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
                values: [[guestId, originalLink, memberName, initialStatus, role, String(initialCount)]],
            },
        });

        return {
            status: existing ? 'updated' : 'created',
            inviteCount: initialCount,
        };
    }
}

// Tăng số lần mời của khách hàng
async function incrementInviteCount(guestId, role) {
    const lookup = await loadGuestLookupAcrossRoles();
    const existing = lookup.get(guestId);
    const sheetTitle = resolveSheetTitle(role);

    if (existing && existing.sheetTitle === sheetTitle) {
        const rowIndex = existing.row.rowIndex;
        const currentCount = parseInt(existing.row.get('So_Lan_Moi') || 0);
        const newCount = currentCount + 1;

        const { sheets } = getSheetsClient();

        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SHEET_ID,
            range: `${sheetTitle}!D${rowIndex}:F${rowIndex}`, 
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [['Đang liên hệ', role, String(newCount)]],
            },
        });

        return newCount;
    }
    return 0;
}

// Đánh dấu không mời lại
async function markAsDoNotInvite(guestId, role) {
    const lookup = await loadGuestLookupAcrossRoles();
    const existing = lookup.get(guestId);
    const sheetTitle = resolveSheetTitle(role);

    if (existing && existing.sheetTitle === sheetTitle) {
        const rowIndex = existing.row.rowIndex;

        const { sheets } = getSheetsClient();

        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SHEET_ID,
            range: `${sheetTitle}!D${rowIndex}`, 
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [['Không mời lại']],
            },
        });
    }
}

// Đánh dấu không mời lại hàng loạt
async function batchMarkDoNotInvite(guestIds, role) {
    if (!Array.isArray(guestIds) || guestIds.length === 0) return { updated: 0 };
    const lookup = await loadGuestLookupAcrossRoles();
    const sheetTitle = resolveSheetTitle(role);
    
    const doc = await initSheet();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { updated: 0 };
    const sheetId = sheet.sheetId;

    const requests = [];
    let updated = 0;

    for (const id of guestIds) {
        const existing = lookup.get(id);
        if (existing && existing.sheetTitle === sheetTitle) {
            const rowIndex = existing.row.rowIndex - 1; 
            requests.push({
                updateCells: {
                    start: { sheetId, rowIndex, columnIndex: 3 }, 
                    rows: [{ values: [{ userEnteredValue: { stringValue: 'Không mời lại' } }] }],
                    fields: 'userEnteredValue'
                }
            });
            updated++;
        }
    }

    if (requests.length === 0) return { updated: 0 };

    const { sheets } = getSheetsClient();
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.SHEET_ID,
        requestBody: { requests },
    });
    return { updated };
}

// Xử lý hàng loạt các hành động
async function batchProcessActions(links, role, memberName, actionName) {
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

    const { sheets } = getSheetsClient();
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

// Đọc cache link share (Dùng Sheets API nhẹ)
let shareCacheMap = null;

async function loadShareCacheIntoMemory() {
    if (shareCacheMap) return;
    shareCacheMap = new Map();
    try {
        const { sheets } = getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SHEET_ID,
            range: `${SHARE_CACHE_SHEET}!A2:C`,
        });
        const rows = response.data.values || [];
        rows.forEach(row => {
            const shareUrl = row[0];
            if (shareUrl) {
                shareCacheMap.set(shareUrl, {
                    originalLink: row[1] || '',
                    guestId: row[2] || '',
                });
            }
        });
    } catch (e) {
        console.error('loadShareCacheIntoMemory error:', e.message);
        shareCacheMap = null;
    }
}

// Đọc cache link share (Dùng in-memory cache kết hợp Sheets API)
async function getShareCache(shareUrl) {
    await loadShareCacheIntoMemory();
    if (shareCacheMap && shareCacheMap.has(shareUrl)) {
        return shareCacheMap.get(shareUrl);
    }
    return null;
}

// Ghi cache link share (Dùng in-memory cache kết hợp Sheets API, chặn trùng lặp)
async function setShareCache(shareUrl, originalLink, guestId) {
    await loadShareCacheIntoMemory();
    if (shareCacheMap && shareCacheMap.has(shareUrl)) {
        return;
    }
    
    try {
        const { sheets } = getSheetsClient();
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SHEET_ID,
            range: `${SHARE_CACHE_SHEET}!A:D`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
                values: [[shareUrl, originalLink || '', guestId || '', new Date().toISOString()]],
            },
        });
        
        if (shareCacheMap) {
            shareCacheMap.set(shareUrl, {
                originalLink: originalLink || '',
                guestId: guestId || '',
            });
        }
    } catch (e) {
        console.error('setShareCache error:', e.message);
    }
}

module.exports = {
    findGuestRowAcrossRoles,
    loadGuestLookupAcrossRoles,
    loadRoleRows,
    saveOrUpdateRole,
    incrementInviteCount,
    markAsDoNotInvite,
    resolveSheetTitle,
    batchMarkDoNotInvite,
    batchProcessActions,
    getShareCache,
    setShareCache,
};
