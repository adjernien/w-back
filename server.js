const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const crypto = require('crypto');
require('dotenv').config();

// Initialize Firebase Admin
//const serviceAccount = require('./serviceAccountKey.json');
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Middleware pour vérifier le token Apple
const verifyAppleToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    // Vérification du token Firebase (qui gère Apple Sign-In)
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Erreur vérification token:', error);
    res.status(401).json({ error: 'Token invalide' });
  }
};

// Routes

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'Wishlist POC Backend OK' });
});

// Créer ou récupérer un utilisateur après Apple Sign-In
app.post('/api/users/setup', verifyAppleToken, async (req, res) => {
  try {
    const { displayName, email } = req.body;
    const userId = req.user.uid;

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      // Créer nouvel utilisateur
      const userData = {
        id: userId,
        displayName: displayName || email?.split('@')[0] || 'Utilisateur',
        email: email || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        wishlistId: null
      };
      
      await userRef.set(userData);
      res.json({ user: userData, isNew: true });
    } else {
      res.json({ user: userDoc.data(), isNew: false });
    }
  } catch (error) {
    console.error('Erreur setup utilisateur:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Créer une wishlist
app.post('/api/wishlists', verifyAppleToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = req.user.uid;

    // Vérifier si l'utilisateur a déjà une wishlist
    const userRef = db.collection('users').doc(userId);
    const user = await userRef.get();
    
    if (user.data()?.wishlistId) {
      return res.status(400).json({ error: 'Utilisateur a déjà une wishlist' });
    }

    const wishlistId = crypto.randomUUID();
    const wishlistData = {
      id: wishlistId,
      userId: userId,
      name: name || 'Ma Wishlist',
      description: description || '',
      items: [],
      totalAmount: 0,
      collectedAmount: 0,
      qrCode: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true
    };

    // Générer QR Code avec deep link
    const deepLink = `wishlist://view/${wishlistId}`;
    const qrCodeDataURL = await QRCode.toDataURL(deepLink, {
      width: 256,
      margin: 2
    });
    
    wishlistData.qrCode = qrCodeDataURL;
    wishlistData.deepLink = deepLink;

    // Sauvegarder la wishlist
    await db.collection('wishlists').doc(wishlistId).set(wishlistData);

    // Mettre à jour l'utilisateur
    await userRef.update({ wishlistId: wishlistId });

    res.json({ wishlist: wishlistData });
  } catch (error) {
    console.error('Erreur création wishlist:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer ma wishlist
app.get('/api/my-wishlist', verifyAppleToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    
    const userDoc = await db.collection('users').doc(userId).get();
    const wishlistId = userDoc.data()?.wishlistId;

    if (!wishlistId) {
      return res.json({ wishlist: null });
    }

    const wishlistDoc = await db.collection('wishlists').doc(wishlistId).get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }

    res.json({ wishlist: wishlistDoc.data() });
  } catch (error) {
    console.error('Erreur récupération wishlist:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer une wishlist par ID (pour le scan QR)
app.get('/api/wishlists/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const wishlistDoc = await db.collection('wishlists').doc(id).get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }

    const wishlistData = wishlistDoc.data();
    
    // Récupérer le nom du propriétaire
    const ownerDoc = await db.collection('users').doc(wishlistData.userId).get();
    const ownerName = ownerDoc.data()?.displayName || 'Utilisateur';

    res.json({ 
      wishlist: {
        ...wishlistData,
        ownerName
      }
    });
  } catch (error) {
    console.error('Erreur récupération wishlist:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ajouter un item à ma wishlist
app.post('/api/my-wishlist/items', verifyAppleToken, async (req, res) => {
  try {
    const { name, price, description, imageUrl } = req.body;
    const userId = req.user.uid;

    const userDoc = await db.collection('users').doc(userId).get();
    const wishlistId = userDoc.data()?.wishlistId;

    if (!wishlistId) {
      return res.status(400).json({ error: 'Aucune wishlist trouvée' });
    }

    const itemId = crypto.randomUUID();
    const newItem = {
      id: itemId,
      name: name || 'Item sans nom',
      price: parseFloat(price) || 0,
      description: description || '',
      imageUrl: imageUrl || null,
      collectedAmount: 0,
      isCompleted: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const wishlistRef = db.collection('wishlists').doc(wishlistId);
    
    await wishlistRef.update({
      items: admin.firestore.FieldValue.arrayUnion(newItem),
      totalAmount: admin.firestore.FieldValue.increment(newItem.price)
    });

    res.json({ item: newItem });
  } catch (error) {
    console.error('Erreur ajout item:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Simuler une contribution
app.post('/api/wishlists/:id/contribute', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, contributorName, message } = req.body;

    const contributionAmount = parseFloat(amount) || 0;
    
    if (contributionAmount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    const contributionId = crypto.randomUUID();
    const contribution = {
      id: contributionId,
      wishlistId: id,
      amount: contributionAmount,
      contributorName: contributorName || 'Anonyme',
      message: message || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Sauvegarder la contribution
    await db.collection('contributions').doc(contributionId).set(contribution);

    // Mettre à jour le montant collecté
    const wishlistRef = db.collection('wishlists').doc(id);
    await wishlistRef.update({
      collectedAmount: admin.firestore.FieldValue.increment(contributionAmount)
    });

    res.json({ 
      success: true, 
      contribution,
      message: 'Contribution simulée avec succès !' 
    });
  } catch (error) {
    console.error('Erreur contribution:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les contributions d'une wishlist
app.get('/api/wishlists/:id/contributions', async (req, res) => {
  try {
    const { id } = req.params;
    
    const contributionsQuery = db.collection('contributions')
      .where('wishlistId', '==', id)
      .orderBy('createdAt', 'desc');
    
    const contributionsSnapshot = await contributionsQuery.get();
    const contributions = contributionsSnapshot.docs.map(doc => doc.data());

    res.json({ contributions });
  } catch (error) {
    console.error('Erreur récupération contributions:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📱 Prêt pour les requêtes iOS !`);
});