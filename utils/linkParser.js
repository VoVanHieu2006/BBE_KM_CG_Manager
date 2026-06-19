function extractFacebookID(url) {
    try {
        const cleanUrl = new URL(url);
        cleanUrl.searchParams.delete('mibextid');
        cleanUrl.searchParams.delete('eav');
        cleanUrl.searchParams.delete('paipv');
        const urlString = cleanUrl.toString();

        const idMatch = urlString.match(/profile\.php\?id=(\d+)/);
        if (idMatch) return idMatch[1];

        const usernameMatch = urlString.match(/(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/([a-zA-Z0-9.]+)/);
        if (usernameMatch && usernameMatch[1] !== 'profile.php') {
            return usernameMatch[1].replace(/\/$/, "");
        }
        return null;
    } catch (error) {
        return null;
    }
}
module.exports = { extractFacebookID };