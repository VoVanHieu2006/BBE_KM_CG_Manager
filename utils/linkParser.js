function extractFacebookID(text) {
    try {
        // 1. Cắt lấy đúng phần URL trong văn bản
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const matches = text.match(urlRegex);
        if (!matches) return null;
        
        let rawUrl = matches[0];
        const cleanUrl = new URL(rawUrl);
        
        // 🔒 BƯỚC 0: Kiểm tra xem URL có phải từ facebook.com không
        const hostname = cleanUrl.hostname;
        const isFacebookUrl = hostname.includes('facebook.com') || hostname.includes('fb.com');
        if (!isFacebookUrl) return null; // Reject non-Facebook URLs (stickers, images, etc.)
        
        // 2. Xóa thông số rác
        cleanUrl.searchParams.delete('mibextid');
        cleanUrl.searchParams.delete('eav');
        cleanUrl.searchParams.delete('paipv');
        cleanUrl.searchParams.delete('rdid');
        cleanUrl.searchParams.delete('share_url');
        
        const urlString = cleanUrl.toString();

        // 🟢 TRƯỜNG HỢP MỚI: Bắt link rút gọn dạng /share/xxxx/ của Mobile
        const shareMatch = urlString.match(/\/share\/([a-zA-Z0-9_-]+)/);
        if (shareMatch) {
            return shareMatch[1]; // Trả về mã băm (ví dụ: 14g9bbx18Hh) làm ID
        }

        // 3. Trường hợp truyền thống 1: id=1000xxx
        const idMatch = urlString.match(/id=(\d+)/);
        if (idMatch) return idMatch[1];

        // 4. Trường hợp truyền thống 2: Username (facebook.com/zuck)
        const usernameMatch = urlString.match(/(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/([a-zA-Z0-9.]+)/);
        
        if (usernameMatch) {
            let username = usernameMatch[1].replace(/\/$/, ""); 
            
            // Đã loại chữ 'share' ra khỏi danh sách đen vì đã xử lý ở trên
            const invalidPaths = ['profile.php', 'groups', 'pages', 'events', 'watch', 'story.php'];
            if (!invalidPaths.includes(username)) {
                return username;
            }
        }
        
        // 5. Cứu cánh: tham số fbid
        if (cleanUrl.searchParams.has('fbid')) {
            return cleanUrl.searchParams.get('fbid');
        }

        return null;
    } catch (error) {
        return null;
    }
}

module.exports = { extractFacebookID };