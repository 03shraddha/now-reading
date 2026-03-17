import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCkkIMQfY1YkroRaoh2o5fEchTnm_plzb8",
  authDomain: "reading-links-fed4e.firebaseapp.com",
  projectId: "reading-links-fed4e",
  storageBucket: "reading-links-fed4e.firebasestorage.app",
  messagingSenderId: "279068642970",
  appId: "1:279068642970:web:dd393c6a075f4c26c3d923",
  measurementId: "G-BKKL32ST6G",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
