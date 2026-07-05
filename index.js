require('dotenv').config();
const express = require('express');
const { getWebhook, postWebhook } = require('./controllers/webhookController');

const app = express();
app.use(express.json());

app.get('/ping', (req, res) => {
    res.status(200).send('Server is awake!');
});

app.get('/webhook', getWebhook);
app.post('/webhook', postWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BBE Bot API đang chạy mượt mà trên Localhost, port ${PORT}`));
