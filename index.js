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
  'https://www.googleapis.com/auth/classroom.coursework.me',
  'https://www.googleapis.com/auth/classroom.coursework.students',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials',
  'https://www.googleapis.com/auth/classroom.topics',
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
const fetchDistanceMonths = 0.5;
const colors = {
  // Announcement
  Annoucement: 0x03DAC5,
  // ClassWork
  ClassWork: 0x3700B3
}
// DataBase Functions
const getData = async (key, def) => await storage.getItem(key) ?? def;
const setData = async (key, value) => await storage.setItem(key, value);
// const setData = async (key, value) => {
//   if (key == 'lastDate') console.log(`Debug - Saving: ${key}`)
//   else await storage.setItem(key, value);
// }
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
  const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, domain);
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
      // Get The Code
      const queryParams = new url.URL(req.url, domain).searchParams;
      const code = queryParams.get('code');
      if (code != undefined) {
        // Send Back A Message
        res.end('Authentication successful! Please return to the console.');
        // Close The Servers
        server.destroy();
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
        res.end(`<a href="${authorizationUrl}">Login</a>`);
      }
    });
    server.listen(port, () => {
      // // Open The Page
      // open(authorizationUrl, {wait: false}).then(cp => cp.unref());
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
  // Determine Batch Size
  const rawAnnouncements = await fetchBatchAnnouncements(api, classID, toDate, 1, undefined);
  // In Parrellel
  const messages = await Promise.all(rawAnnouncements.map(async (annoucment) => {
    // Fetch User Data For Announcements
    const userData = await fetchUser(api, annoucment.creatorUserId);
    // Make Announcements Into Pretty Message
    const imageUrl = `https:${userData?.photoUrl ?? '//lh3.googleusercontent.com/a-/AOh14Gj-cdUSUVoEge7rD5a063tQkyTDT3mripEuDZ0v=s100'}`;
    return {
      title: userData?.name?.fullName ?? 'Announcement Bot',
      color: colors.Annoucement,
      thumbnail: {
        url: imageUrl
      },
      description: annoucment.text.trim(),
      timestamp: annoucment.creationTime,
      author: {
        name: userData?.name?.fullName ?? 'Announcement Bot',
        url: imageUrl,
        icon_url: imageUrl
      },
      footer: {
        text: annoucment.id,
        icon_url: imageUrl
      },
      url: annoucment.alternateLink
    }
  }));
  // Return Announcements
  return messages;
};
const fetchBatchWork = async (api, classID, toDate, batchSize, lastPage = undefined, depth = 0) => {
  const { classroom } = api;
  // Our Announcements
  const announcements = [];
  // Get The Number of announcements
  const { data: announcementData } = await classroom.courses.courseWork.list({
    // Identifier of the course. This identifier can be either the Classroom-assigned identifier or an alias.
    courseId: classID,
    pageSize: `${batchSize}`,
    pageToken: lastPage ?? ''
  });
  // Push the annoucementData
  announcements.push(...announcementData.courseWork);
  // Return if no annoucements
  if (announcements.length <= 0) return announcements;
  if (depth >= 20) return annoucements; // dont go to deep
  // Handle Fetching More
  const lastMessageDate = new Date(announcementData.courseWork.at(-1).creationTime);
  if (toDate < lastMessageDate) {
    const _daysBetween = Math.ceil((lastMessageDate.getTime() - toDate.getTime()) / (1000 * 3600 * 24));
    const daysBetween = _daysBetween <= 100 ? _daysBetween : 100;
    // Fetch More Annoucements
    const _announcementData = await fetchBatchWork(api, classID, toDate, daysBetween, announcementData.nextPageToken, depth++);
    // Add this to annoucements
    announcements.push(..._announcementData);
  } else {
    // Otherwise trim the annoucements object to end at the toDate
    return announcements.filter((annoucement) => new Date(annoucement.creationTime) >= toDate);
  }
  // Return the announcements
  return announcements.reverse();
}
const fetchWork = async (api, classID, toDate) => {
  const { classroom } = api;
  // Determine Batch Size
  const rawAnnouncements = await fetchBatchWork(api, classID, toDate, 1, undefined);
  // In Parrellel
  const messages = await Promise.all(rawAnnouncements.map(async (annoucment) => {
    // Fetch User Data For Announcements
    const userData = await fetchUser(api, annoucment.creatorUserId);
    // Make Announcements Into Pretty Message
    const imageUrl = `https:${userData?.photoUrl ?? '//lh3.googleusercontent.com/a-/AOh14Gj-cdUSUVoEge7rD5a063tQkyTDT3mripEuDZ0v=s100'}`;
    return {
      title: annoucment.title,
      color: colors.ClassWork,
      thumbnail: {
        url: imageUrl
      },
      description: annoucment.description.trim(),
      timestamp: annoucment.creationTime,
      author: {
        name: userData?.name?.fullName ?? 'Announcement Bot',
        url: imageUrl,
        icon_url: imageUrl
      },
      footer: {
        text: annoucment.id,
        icon_url: imageUrl
      },
      url: annoucment.alternateLink
    }
  }));
  // Return Announcements
  return messages;
};
const fetchBatchMaterials = async (api, classID, toDate, batchSize, lastPage = undefined, depth = 0) => {
  const { classroom } = api;
  // Our Announcements
  const announcements = [];
  // Get The Number of announcements
  const { data: announcementData } = await classroom.courses.courseWorkMaterials.list({
    // Identifier of the course. This identifier can be either the Classroom-assigned identifier or an alias.
    courseId: classID,
    pageSize: `${batchSize}`,
    pageToken: lastPage ?? ''
  });
  // Push the annoucementData
  announcements.push(...announcementData.courseWorkMaterial);
  // Return if no annoucements
  if (announcements.length <= 0) return announcements;
  if (depth >= 20) return annoucements; // dont go to deep
  // Handle Fetching More
  const lastMessageDate = new Date(announcementData.courseWorkMaterial.at(-1).creationTime);
  if (toDate < lastMessageDate) {
    const _daysBetween = Math.ceil((lastMessageDate.getTime() - toDate.getTime()) / (1000 * 3600 * 24));
    const daysBetween = _daysBetween <= 100 ? _daysBetween : 100;
    // Fetch More Annoucements
    const _announcementData = await fetchBatchMaterials(api, classID, toDate, daysBetween, announcementData.nextPageToken, depth++);
    // Add this to annoucements
    announcements.push(..._announcementData);
  } else {
    // Otherwise trim the annoucements object to end at the toDate
    return announcements.filter((annoucement) => new Date(annoucement.creationTime) >= toDate);
  }
  // Return the announcements
  return announcements.reverse();
}
const fetchMaterials = async (api, classID, toDate) => {
  const { classroom } = api;
  // Determine Batch Size
  const rawAnnouncements = await fetchBatchMaterials(api, classID, toDate, 1, undefined);
  // In Parrellel
  const messages = await Promise.all(rawAnnouncements.map(async (annoucment) => {
    // Fetch User Data For Announcements
    const userData = await fetchUser(api, annoucment.creatorUserId);
    // Make Announcements Into Pretty Message
    const imageUrl = `https:${userData?.photoUrl ?? '//lh3.googleusercontent.com/a-/AOh14Gj-cdUSUVoEge7rD5a063tQkyTDT3mripEuDZ0v=s100'}`;
    return {
      title: annoucment.title,
      color: colors.ClassWork,
      thumbnail: {
        url: imageUrl
      },
      description: annoucment.description.trim(),
      timestamp: annoucment.creationTime,
      author: {
        name: userData?.name?.fullName ?? 'Announcement Bot',
        url: imageUrl,
        icon_url: imageUrl
      },
      footer: {
        text: annoucment.id,
        icon_url: imageUrl
      },
      url: annoucment.alternateLink
    }
  }));
  // Return Announcements
  return messages;
};
const fetchClass = async (api, classID) => {
  const { classroom } = api;
  const { data: classInfo } = await classroom.courses.get({ id: classID });
  return classInfo;
}
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
      let lastDate = await getData('lastDate', undefined);
      // Determine Date
      const { creationTime } = await fetchClass(api, classID);
      // Determine toDate Validity
      if (!(lastDate instanceof Date) || lastDate < creationTime)
        lastDate = new Date(creationTime);
      // Get Date Four Months Ago
      const today = new Date();
      const oneMonthAgo = new Date(today.getFullYear(), today.getMonth() - fetchDistanceMonths, today.getDate());
      if (lastDate < oneMonthAgo) lastDate = oneMonthAgo;
      // Save Date
      await setData('lastDate', (new Date()).toJSON());
      // Fetch Data 
      const _announcements = await fetchAnnouncements(api, classID, lastDate != undefined ? new Date(lastDate) : undefined);
      const _work = await fetchWork(api, classID, lastDate != undefined ? new Date(lastDate) : undefined);
      const _materials = await fetchMaterials(api, classID, lastDate != undefined ? new Date(lastDate) : undefined);
      // Sort Data
      const _messages = [..._announcements, ..._work, ..._materials];
      _messages.sort((a, b) => new Date(a.timestamp)-new Date(b.timestamp));
      // Send Data
      console.log('sending');
      for (const msgs of chunkArray(_messages, 10)) {
        await sendDiscordMessage(webhook, {
          username: 'Announcement Bot',
          avatar_url: 'https://ssl.gstatic.com/classroom/favicon.png',
          content: '<@&1027417122055401532> New Announcement',
          embeds: msgs
        })
      }
      console.log('done sending');
    } catch (e) {
      console.log(e);
      console.log('Error Fetching Announcements');
      if (e.errors && e.errors[0].message == 'Insufficient Permission') {
        await setData('refresh_token', '');
        await sendDiscordMessage(webhook, {
          username: 'Announcement Bot',
          avatar_url: 'https://ssl.gstatic.com/classroom/favicon.png',
          content: '<@!524413155212787743> Permission Issue'
        })
        process.exit();
      }
    }
  }
  intervalLoop();
  setInterval(async () => intervalLoop(), fetchInterval)
}

await main();