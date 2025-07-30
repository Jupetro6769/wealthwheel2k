const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Airtable Configuration ---
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_USER_TABLE = 'User'; // Correct table name from brief
const airtableApi = axios.create({
    baseURL: `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`,
    headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
    },
});

// --- Endpoint to Create/Update User and Prepare for Payment ---
app.post('/api/users/create', async (req, res) => {
    const { name, email, phone, refCode } = req.body;

    if (!name || !email || !phone) {
        return res.status(400).json({ error: 'Name, email, and phone are required.' });
    }

    try {
        // 1. Find Referrer if refCode is provided
        let referrerRecordId = null;
        if (refCode) {
            const findReferrer = await airtableApi.get(`/${AIRTABLE_USER_TABLE}`, {
                params: { filterByFormula: `{url-ref} = '${refCode}'` }
            });
            if (findReferrer.data.records.length > 0) {
                referrerRecordId = findReferrer.data.records[0].id;
            } else {
                return res.status(404).json({ error: 'Invalid referral code.' });
            }
        }

        // 2. Check for existing user by email
        const findUser = await airtableApi.get(`/${AIRTABLE_USER_TABLE}`, {
            params: { filterByFormula: `{Email} = '${email}'` }
        });

        let userRecord;
        const userData = {
            "Name": name,
            "Email": email,
            "Phone": phone,
            "Status": "Invited",
            ...(referrerRecordId && { "ReferredBy": [referrerRecordId] })
        };

        if (findUser.data.records.length > 0) {
            // User exists, check status
            const existingUser = findUser.data.records[0];
            if (existingUser.fields.Status === 'Paid') {
                return res.status(409).json({ error: 'This email is already registered and paid.' });
            }
            // Update existing unpaid user
            const { data } = await airtableApi.patch(`/${AIRTABLE_USER_TABLE}/${existingUser.id}`, { fields: userData });
            userRecord = data;
        } else {
            // Create new user
            const { data } = await airtableApi.post(`/${AIRTABLE_USER_TABLE}`, { fields: userData });
            userRecord = data;
        }

        res.status(200).json({ userId: userRecord.id });

    } catch (error) {
        console.error('Error in /api/users/create:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'An error occurred while setting up your profile.' });
    }
});

// --- Endpoint to Verify Yoco Payment Token and Finalize Registration ---
app.post('/api/payments/verify', async (req, res) => {
    const { token, userId } = req.body;
    const amountInCents = 20000; // R200 once-off

    if (!token || !userId) {
        return res.status(400).json({ error: 'Payment token and user ID are required.' });
    }

    try {
        // 1. Charge the card using the token via Yoco API
        const yocoResponse = await axios.post('https://online.yoco.com/v1/charges/', {
            token: token,
            amountInCents: amountInCents,
            currency: 'ZAR',
        }, {
            headers: { 'X-Auth-Secret-Key': process.env.YOCO_SECRET_KEY }
        });

        // 2. If charge is successful, update user status in Airtable
        if (yocoResponse.data && yocoResponse.data.status === 'successful') {
            await airtableApi.patch(`/${AIRTABLE_USER_TABLE}/${userId}`, {
                fields: { "Status": "Paid" }
            });
            res.status(200).json({ status: 'success', message: 'Payment successful and profile activated.' });
        } else {
            throw new Error(yocoResponse.data.displayMessage || 'Payment failed at gateway.');
        }
    } catch (error) {
        console.error('Error in /api/payments/verify:', error.response ? error.response.data : error.message);
        const errorMessage = error.response ? error.response.data.displayMessage : 'Payment verification failed.';
        res.status(500).json({ error: errorMessage });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Wealth Wheel server running on port ${PORT}`);
});
