function createGuestNode(data) {
    return {
        row: {
            rowIndex: data.rowIndex,
            get: (colName) => {
                const mapping = {
                    'ID_Khach': data.guestId,
                    'Link_Goc': data.originalLink,
                    'Nguoi_Moi': data.nguoiMoi,
                    'Trang_Thai': data.trangThai,
                    'Phan_Loai': data.phanLoai,
                    'So_Lan_Moi': data.soLanMoi,
                };
                return mapping[colName] || '';
            },
            set: (colName, value) => {
                if (colName === 'Trang_Thai') data.trangThai = value;
                else if (colName === 'So_Lan_Moi') data.soLanMoi = String(value);
                else if (colName === 'Nguoi_Moi') data.nguoiMoi = value;
                else if (colName === 'Phan_Loai') data.phanLoai = value;
            },
            setRowIndex: (idx) => {
                data.rowIndex = idx;
            }
        },
        sheetTitle: data.sheetTitle,
        raw: data
    };
}

module.exports = { createGuestNode };
