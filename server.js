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
        createdAt: admin.firestore.FieldValue.serverTimestamp()
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
      createdAt: new Date(),
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

    res.json({ wishlist: wishlistData });
  } catch (error) {
    console.error('Erreur création wishlist:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer toutes mes wishlists
app.get('/api/my-wishlists', verifyAppleToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    
    // UN SEUL filtre - pas d'index composite nécessaire
    const wishlistsQuery = db.collection('wishlists')
      .where('userId', '==', userId);
    
    const wishlistsSnapshot = await wishlistsQuery.get();
    let wishlists = wishlistsSnapshot.docs.map(doc => doc.data());
    
    // Filtrer manuellement les wishlists actives
    wishlists = wishlists.filter(wishlist => wishlist.isActive === true);
    
    // Trier manuellement par date (plus récent en premier)
    wishlists.sort((a, b) => {
      const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
      const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
      return dateB - dateA;
    });

    res.json({ wishlists });
  } catch (error) {
    console.error('Erreur récupération wishlists:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer une wishlist spécifique de l'utilisateur
app.get('/api/my-wishlists/:wishlistId', verifyAppleToken, async (req, res) => {
  try {
    const { wishlistId } = req.params;
    const userId = req.user.uid;
    
    const wishlistDoc = await db.collection('wishlists').doc(wishlistId).get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }

    const wishlistData = wishlistDoc.data();
    
    // Vérifier que la wishlist appartient à l'utilisateur
    if (wishlistData.userId !== userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    res.json({ wishlist: wishlistData });
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

// Ajouter un item à une wishlist spécifique
app.post('/api/wishlists/:wishlistId/items', verifyAppleToken, async (req, res) => {
  try {
    const { wishlistId } = req.params;
    const { name, price, description, imageUrl } = req.body;
    const userId = req.user.uid;

    // Vérifier que la wishlist existe et appartient à l'utilisateur
    const wishlistDoc = await db.collection('wishlists').doc(wishlistId).get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }
    
    const wishlistData = wishlistDoc.data();
    if (wishlistData.userId !== userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
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
      createdAt: new Date() // ← Changé ici : utilise new Date() au lieu de serverTimestamp()
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

// Modifier un item d'une wishlist spécifique
app.put('/api/wishlists/:wishlistId/items/:itemId', verifyAppleToken, async (req, res) => {
  try {
    const { wishlistId, itemId } = req.params;
    const { name, price, description, imageUrl } = req.body;
    const userId = req.user.uid;

    // Vérifier que la wishlist existe et appartient à l'utilisateur
    const wishlistRef = db.collection('wishlists').doc(wishlistId);
    const wishlistDoc = await wishlistRef.get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }
    
    const wishlistData = wishlistDoc.data();
    if (wishlistData.userId !== userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    // Trouver l'item à modifier
    const items = wishlistData.items || [];
    const itemIndex = items.findIndex(item => item.id === itemId);

    if (itemIndex === -1) {
      return res.status(404).json({ error: 'Item non trouvé' });
    }

    const oldItem = items[itemIndex];
    const priceDifference = (parseFloat(price) || 0) - oldItem.price;

    // Mettre à jour l'item
    const updatedItem = {
      ...oldItem,
      name: name || oldItem.name,
      price: parseFloat(price) || 0,
      description: description || '',
      imageUrl: imageUrl || null
    };

    items[itemIndex] = updatedItem;

    // Mettre à jour la wishlist
    await wishlistRef.update({
      items: items,
      totalAmount: admin.firestore.FieldValue.increment(priceDifference)
    });

    res.json({
      success: true,
      item: updatedItem,
      message: 'Item modifié avec succès'
    });
  } catch (error) {
    console.error('Erreur modification item:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer un item d'une wishlist spécifique
app.delete('/api/wishlists/:wishlistId/items/:itemId', verifyAppleToken, async (req, res) => {
  try {
    const { wishlistId, itemId } = req.params;
    const userId = req.user.uid;

    // Vérifier que la wishlist existe et appartient à l'utilisateur
    const wishlistRef = db.collection('wishlists').doc(wishlistId);
    const wishlistDoc = await wishlistRef.get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }
    
    const wishlistData = wishlistDoc.data();
    if (wishlistData.userId !== userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    // Trouver l'item à supprimer
    const items = wishlistData.items || [];
    const itemToDelete = items.find(item => item.id === itemId);

    if (!itemToDelete) {
      return res.status(404).json({ error: 'Item non trouvé' });
    }

    // Supprimer l'item du tableau
    const updatedItems = items.filter(item => item.id !== itemId);

    // Mettre à jour la wishlist
    await wishlistRef.update({
      items: updatedItems,
      totalAmount: admin.firestore.FieldValue.increment(-itemToDelete.price),
      collectedAmount: admin.firestore.FieldValue.increment(-itemToDelete.collectedAmount)
    });

    res.json({
      success: true,
      message: 'Item supprimé avec succès'
    });
  } catch (error) {
    console.error('Erreur suppression item:', error);
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

// Modifier les informations d'une wishlist
app.put('/api/wishlists/:wishlistId', verifyAppleToken, async (req, res) => {
  try {
    const { wishlistId } = req.params;
    const { name, description } = req.body;
    const userId = req.user.uid;

    // Vérifier que la wishlist existe et appartient à l'utilisateur
    const wishlistRef = db.collection('wishlists').doc(wishlistId);
    const wishlistDoc = await wishlistRef.get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }
    
    const wishlistData = wishlistDoc.data();
    if (wishlistData.userId !== userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    // Préparer les données à mettre à jour
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;

    // Mettre à jour la wishlist
    await wishlistRef.update(updateData);

    // Récupérer la wishlist mise à jour
    const updatedWishlistDoc = await wishlistRef.get();
    
    res.json({
      success: true,
      wishlist: updatedWishlistDoc.data(),
      message: 'Wishlist modifiée avec succès'
    });
  } catch (error) {
    console.error('Erreur modification wishlist:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer une wishlist
app.delete('/api/wishlists/:wishlistId', verifyAppleToken, async (req, res) => {
  try {
    const { wishlistId } = req.params;
    const userId = req.user.uid;

    // Vérifier que la wishlist existe et appartient à l'utilisateur
    const wishlistRef = db.collection('wishlists').doc(wishlistId);
    const wishlistDoc = await wishlistRef.get();
    
    if (!wishlistDoc.exists) {
      return res.status(404).json({ error: 'Wishlist non trouvée' });
    }
    
    const wishlistData = wishlistDoc.data();
    if (wishlistData.userId !== userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    // Marquer la wishlist comme inactive au lieu de la supprimer complètement
    // pour préserver l'historique des contributions
    await wishlistRef.update({
      isActive: false,
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Wishlist supprimée avec succès'
    });
  } catch (error) {
    console.error('Erreur suppression wishlist:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

 // Récupérer la liste des amis
 app.get('/api/friends', verifyAppleToken, async (req, res) => {
  try {
    const userId = req.user.uid;

    const userDoc = await db.collection('users').doc(userId).get();
    const friendIds = userDoc.data()?.friends || [];

    if (friendIds.length === 0) {
      return res.json({ friends: [] });
    }

    const friendsQuery = db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', friendIds);
    const friendsSnapshot = await friendsQuery.get();

    const friends = friendsSnapshot.docs.map(doc => ({
      id: doc.id,
      displayName: doc.data().displayName,
      email: doc.data().email,
      addedAt: new Date() // Vous pouvez stocker la vraie date d'ajout
    }));

    res.json({ friends });
  } catch (error) {
    console.error('Erreur récupération amis:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ajouter un ami par email
app.post('/api/friends/add-by-email', verifyAppleToken, async (req, res) => {
  try {
    const { email } = req.body;
    const userId = req.user.uid;

    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }

    // Chercher l'utilisateur par email
    const usersQuery = db.collection('users').where('email', '==', email);
    const usersSnapshot = await usersQuery.get();

    if (usersSnapshot.empty) {
      return res.status(404).json({ error: 'Utilisateur non trouvé avec cet email' });
    }

    const friendDoc = usersSnapshot.docs[0];
    const friendId = friendDoc.id;

    if (friendId === userId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas vous ajouter vous-même' });
    }

    // Ajouter à la liste d'amis
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      friends: admin.firestore.FieldValue.arrayUnion(friendId)
    });

    // Ajouter réciproquement
    const friendRef = db.collection('users').doc(friendId);
    await friendRef.update({
      friends: admin.firestore.FieldValue.arrayUnion(userId)
    });

    res.json({
      success: true,
      message: 'Ami ajouté avec succès',
      friend: {
        id: friendId,
        displayName: friendDoc.data().displayName,
        email: friendDoc.data().email
      }
    });
  } catch (error) {
    console.error('Erreur ajout ami par email:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ajouter un ami par QR code
app.post('/api/friends/add-by-qr', verifyAppleToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    const userId = req.user.uid;

    if (!friendId) {
      return res.status(400).json({ error: 'ID ami requis' });
    }

    if (friendId === userId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas vous ajouter vous-même' });
    }

    // Vérifier que l'ami existe
    const friendDoc = await db.collection('users').doc(friendId).get();
    if (!friendDoc.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Vérifier s'ils ne sont pas déjà amis
    const userDoc = await db.collection('users').doc(userId).get();
    const currentFriends = userDoc.data()?.friends || [];

    if (currentFriends.includes(friendId)) {
      return res.status(400).json({ error: 'Vous êtes déjà amis' });
    }

    // Ajouter à la liste d'amis
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      friends: admin.firestore.FieldValue.arrayUnion(friendId)
    });

    // Ajouter réciproquement
    const friendRef = db.collection('users').doc(friendId);
    await friendRef.update({
      friends: admin.firestore.FieldValue.arrayUnion(userId)
    });

    res.json({
      success: true,
      message: 'Ami ajouté avec succès',
      friend: {
        id: friendId,
        displayName: friendDoc.data().displayName,
        email: friendDoc.data().email
      }
    });
  } catch (error) {
    console.error('Erreur ajout ami par QR:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📱 Prêt pour les requêtes iOS !`);
});