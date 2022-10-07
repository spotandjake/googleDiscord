// // Imports
import dotenv from 'dotenv';
import { google } from 'googleapis';
import destroyer from 'server-destroy';
import storage from 'node-persist';
import open from 'open';
import http from 'http';
import url from 'url';
// Configs
dotenv.config();
const scopes = [
  'https://www.googleapis.com/auth/classroom.announcements',
  'https://www.googleapis.com/auth/classroom.courses',
  'https://www.googleapis.com/auth/classroom.profile.emails',
  'https://www.googleapis.com/auth/classroom.profile.photos',
  'https://www.googleapis.com/auth/classroom.rosters',
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
  'https://www.googleapis.com/auth/user.emails.read',
  'profile',
];
const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const domain = 'http://localhost';
const port = 8080;
const fetchInterval = 1000 * 60 * 1; // ms * min * numberOfMin
const classID = process.env.CLASS_ID;
const webhook = process.env.WEBHOOK;
// DataBase Functions
const getData = async (key, def) => await storage.getItem(key) ?? def;
const setData = async (key, value) => await storage.setItem(key, value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const chunkArray = (inArr, n) => {
  const range = (n) => Array.apply(null,Array(n)).map((x,i) => i);
  return range(Math.ceil(inArr.length/n)).map((x,i) => inArr.slice(i*n,i*n+n));
}
// Authentication
const authenticateUser = () => new Promise(async (resolve, reject) => {
  /**
   * To use OAuth2 authentication, we need access to a CLIENT_ID, CLIENT_SECRET, AND REDIRECT_URI
   * from the client_secret.json file. To get these credentials for your application, visit
   * https://console.cloud.google.com/apis/credentials.
   */
  const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, `${domain}:${port}`);
  // Generate a url that asks permissions for the Drive activity scope
  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes
  });
  oauth2Client.setCredentials({
    refresh_token: await getData('refresh_token', '')
  });
  if (await getData('refresh_token', '') == '') {
    // Create Quick Server
    const server = http.createServer(async (req, res) => {
      if (req.url.indexOf('/') > -1) {
        // Send Back A Message
        res.end('Authentication successful! Please return to the console.');
        // Close The Servers
        server.destroy();
        // Get The Code
        const queryParams = new url.URL(req.url, `${domain}:${port}`).searchParams;
        // Get The Token
        const {tokens} = await oauth2Client.getToken(queryParams.get('code'));
        oauth2Client.credentials = tokens;
        // Store Refresh Token
        if (tokens.refresh_token) await setData('refresh_token', tokens.refresh_token);
        // Handle Refreshed Logins
        oauth2Client.on('tokens', async (tokens) => {
          if (tokens.refresh_token) await setData('refresh_token', tokens.refresh_token);
          console.log('ReAuthenticating');
        });
        // Return the client
        resolve(oauth2Client);
      } else {
        res.end(`Please Authenticate At ${authorizationUrl}`);
      }
    });
    server.listen(port, () => {
      // Open The Page
      open(authorizationUrl, {wait: false}).then(cp => cp.unref());
      // Say Authenticating
      console.log('Authenticating User...');
    });
    destroyer(server);
  } else {
    const {tokens} = await oauth2Client.refreshToken(await getData('refresh_token', ''));
    // Store Refresh Token
    if (tokens.refresh_token) await setData('refresh_token', tokens.refresh_token);
    // Handle Refreshed Logins
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.refresh_token) await setData('refresh_token', tokens.refresh_token);
      console.log('ReAuthenticating');
    });
    // Return the client
    resolve(oauth2Client);
  }
});
// Fetching
const fetchUser = async (api, userID) => {
  const { classroom } = api;
  try {
    const { data: user } = await classroom.userProfiles.get({ userId: userID });
    return user;
  } catch (err) {
    return undefined;
  }
}
const fetchBatchAnnouncements = async (api, classID, toDate, batchSize, lastAnnouncement = undefined, depth = 0) => {
  const { classroom } = api;
  // Our Announcements
  const announcements = [];
  // Get The Number of announcements
  const { data: announcementData } = await classroom.courses.announcements.list({
    // Identifier of the course. This identifier can be either the Classroom-assigned identifier or an alias.
    courseId: classID,
    pageSize: `${batchSize}`,
    pageToken: lastAnnouncement ?? ''
  });
  // Push the annoucementData
  announcements.push(...announcementData.announcements);
  // Return if no annoucements
  if (announcements.length <= 0) return announcements;
  if (depth >= 20) return annoucements; // dont go to deep
  // Handle Fetching More
  const lastMessageDate = new Date(announcementData.announcements.at(-1).creationTime);
  if (toDate < lastMessageDate) {
    const _daysBetween = Math.ceil((lastMessageDate.getTime() - toDate.getTime()) / (1000 * 3600 * 24));
    const daysBetween = _daysBetween <= 100 ? _daysBetween : 100;
    // Fetch More Annoucements
    const _announcementData = await fetchBatchAnnouncements(api, classID, toDate, daysBetween, announcementData.nextPageToken, depth++);
    // Add this to annoucements
    announcements.push(..._announcementData);
  } else {
    // Otherwise trim the annoucements object to end at the toDate
    return announcements.filter((annoucement) => new Date(annoucement.creationTime) >= toDate);
  }
  // Return the announcements
  return announcements.reverse();
}
const fetchAnnouncements = async (api, classID, toDate) => {
  const { classroom } = api;
  // Fetch The Classroom
  const { data: classInfo } = await classroom.courses.get({ id: classID });
  const classCreationDate = new Date(classInfo.creationTime);
  // Determine toDate Validity
  if (!(toDate instanceof Date) || toDate < classCreationDate)
    toDate = new Date(classCreationDate);
  // Get Date Four Months Ago
  const today = new Date();
  const oneMonthAgo = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
  if (toDate < oneMonthAgo) toDate = oneMonthAgo;
  // Determine Batch Size
  const rawAnnouncements = await fetchBatchAnnouncements(api, classID, toDate, 1, undefined);
  // Set Date To Now
  setData('lastDate', (new Date()).toJSON());
  // In Parrellel
  const messages = await Promise.all(rawAnnouncements.map(async (annoucment) => {
    // Fetch User Data For Announcements
    const userData = await fetchUser(api, annoucment.creatorUserId);
    // Make Announcements Into Pretty Message
    return {
      title: userData?.name?.fullName ?? 'Annoucment Bot',
      color: 111,
      thumbnail: {
        url: `https:${userData?.photoUrl ?? '//lh3.googleusercontent.com/a-/AOh14Gj-cdUSUVoEge7rD5a063tQkyTDT3mripEuDZ0v=s100'}`
      },
      description: annoucment.text.trim(),
      timestamp: annoucment.creationTime
    }
  }));
  // Return Announcements
  return messages;
};
const sendDiscordMessage = async (webhook, messageContent) => {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json'
    },
    body: JSON.stringify(messageContent)
  })
  if (res.status != 204) {
    console.log('Discord Failed');
    console.log(await res.text());
  }
  await delay(500);
}
// Main
const main = async () => {
  // Init Storage
  await storage.init();
  // initial auth
  const auth = await authenticateUser();
  // Initialize APIS
  const api = {
    classroom: google.classroom({ version: 'v1', auth: auth })
  };
  // Begin Fetch Loop
  const intervalLoop = async () => {
    console.log('fetching');
    try {
      const lastDate = await getData('lastDate', undefined)
      const _announcements = await fetchAnnouncements(api, classID, lastDate != undefined ? new Date(lastDate) : undefined);
      console.log('sending');
      for (const announcements of chunkArray(_announcements, 10)) {
        await sendDiscordMessage(webhook, {
          username: 'Announcement Bot',
          avatar_url: 'https://lh3.googleusercontent.com/a-/AOh14Gj-cdUSUVoEge7rD5a063tQkyTDT3mripEuDZ0v=s100',
          content: '<@&1027417122055401532> New Announcement',
          embeds: announcements
        })
      }
      console.log('done sending');
    } catch (e) {
      console.log(e);
      console.log('Error Fetching Announcements');
    }
  }
  intervalLoop();
  setInterval(async () => intervalLoop(), fetchInterval)
}

await main();