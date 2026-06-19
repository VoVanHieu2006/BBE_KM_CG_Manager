function extractFacebookID(text) {
    try {
        // 1. Cắt lấy đúng phần URL trong đoạn văn bản (đề phòng có chữ)
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const matches = text.match(urlRegex);
        if (!matches) return null;
        
        let rawUrl = matches[0];
        const cleanUrl = new URL(rawUrl);
        
        // 2. Xóa sạch các thông số tracking của Facebook Mobile
        cleanUrl.searchParams.delete('mibextid');
        cleanUrl.searchParams.delete('eav');
        cleanUrl.searchParams.delete('paipv');
        cleanUrl.searchParams.delete('rdid');
        cleanUrl.searchParams.delete('share_url');
        
        const urlString = cleanUrl.toString();

        // 3. Trường hợp 1: Link có ID số (profile.php?id=...)
        const idMatch = urlString.match(/id=(\d+)/);
        if (idMatch) return idMatch[1];

        // 4. Trường hợp 2: Link chứa Username
        const usernameMatch = urlString.match(/(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/([a-zA-Z0-9.]+)/);
        
        if (usernameMatch) {
            let username = usernameMatch[1].replace(/\/$/, ""); // Bỏ dấu / ở cuối
            
            // Lọc ra các link không phải là trang cá nhân
            const invalidPaths = ['profile.php', 'share', 'groups', 'pages', 'events', 'watch', 'story.php'];
            if (!invalidPaths.includes(username)) {
                return username;
            }
        }
        
        // Cứu cánh: Lấy ID từ tham số fbid nếu có
        if (cleanUrl.searchParams.has('fbid')) {
            return cleanUrl.searchParams.get('fbid');
        }

        return null;
    } catch (error) {
        return null; // Link gãy hoặc không đúng định dạng
    }
}

module.exports = { extractFacebookID };