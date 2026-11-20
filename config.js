// Paste your Firebase web-app config here (Firebase console > Project settings > Your apps > Web app > Config).
// These values are NOT secret: access is controlled by firestore.rules, not by hiding this.
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyB18ubdRGRuWnNMKzTajoI2_QBTkSO0220',
  authDomain: 'phone-tracker-64120.firebaseapp.com',
  projectId: 'phone-tracker-64120',
  storageBucket: 'phone-tracker-64120.firebasestorage.app',
  messagingSenderId: '328756938826',
  appId: '1:328756938826:web:ccdeb697f0d8a997c8beb3'
};
// The Apps Script web app URL (ends in /exec). Public, but every call also needs your Google sign-in token.
export const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbwFh-rg9yzwrgxHI5dYViDO0XCyzE5evfNp6F5q1iDH2exgybTb3tyRNLcmNK9YxgG4dA/exec';
// Bump together with SCHEMA_VERSION in apps-script/Code.gs when the data layout changes.
export const SCHEMA = 1;
