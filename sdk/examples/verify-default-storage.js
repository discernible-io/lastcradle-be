/**
 * Verify Default Storage Setup
 * 
 * This script verifies that the InMemorySessionStorage is properly set as the default
 * and that RoditClient is correctly initialized with it.
 * 
 * Copyright (c) 2025 Discernible, Inc. All rights reserved.
 */

const { RoditClient } = require('../index');
const { sessionManager, InMemorySessionStorage } = require('../lib/auth/sessionmanager');

async function verifyDefaultSetup() {
  console.log('🔍 Verifying Default Session Storage Setup...\n');
  
  // Test 1: Verify sessionManager has default storage
  console.log('1. Checking SessionManager default storage...');
  try {
    const storage = sessionManager.storage;
    const isInMemory = storage instanceof InMemorySessionStorage;
    const storageType = storage.constructor.name;
    
    console.log(`   ✓ Storage type: ${storageType}`);
    console.log(`   ✓ Is InMemorySessionStorage: ${isInMemory}`);
    
    if (!isInMemory) {
      throw new Error(`Expected InMemorySessionStorage, got ${storageType}`);
    }
  } catch (error) {
    console.error('   ✗ SessionManager storage check failed:', error.message);
    return false;
  }
  
  // Test 2: Verify RoditClient can access session storage
  console.log('\n2. Checking RoditClient session storage access...');
  try {
    const client = new RoditClient();
    const sessionMgr = client.getSessionManager();
    const storageInfo = await client.getSessionStorageInfo();
    
    console.log('   ✓ RoditClient has session manager:', !!sessionMgr);
    console.log('   ✓ Storage info:', JSON.stringify(storageInfo, null, 2));
    
    if (storageInfo.storageType !== 'InMemorySessionStorage') {
      throw new Error(`Expected InMemorySessionStorage, got ${storageInfo.storageType}`);
    }
  } catch (error) {
    console.error('   ✗ RoditClient storage access failed:', error.message);
    return false;
  }
  
  // Test 3: Verify storage operations work
  console.log('\n3. Testing basic storage operations...');
  try {
    const client = new RoditClient();
    const sessionMgr = client.getSessionManager();
    
    // Create a test session
    const session = await sessionMgr.createSession({
      roditId: 'verify-test-rodit',
      ownerId: 'verify-test-owner',
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    });
    
    console.log(`   ✓ Session created: ${session.id}`);
    
    // Retrieve the session
    const retrieved = await sessionMgr.getSession(session.id);
    console.log(`   ✓ Session retrieved: ${retrieved ? 'success' : 'failed'}`);
    
    // Check storage count
    const storageInfo = await client.getSessionStorageInfo();
    console.log(`   ✓ Session count: ${storageInfo.sessionCount}`);
    
    // Clean up
    await sessionMgr.closeSession(session.id, 'verification_cleanup');
    console.log('   ✓ Session cleaned up');
    
  } catch (error) {
    console.error('   ✗ Storage operations failed:', error.message);
    return false;
  }
  
  // Test 4: Verify storage interface compliance
  console.log('\n4. Verifying storage interface compliance...');
  try {
    const storage = sessionManager.storage;
    const requiredMethods = ['get', 'set', 'delete', 'keys', 'size', 'clear'];
    const missingMethods = requiredMethods.filter(method => typeof storage[method] !== 'function');
    
    if (missingMethods.length > 0) {
      throw new Error(`Storage missing required methods: ${missingMethods.join(', ')}`);
    }
    
    console.log('   ✓ All required methods present:', requiredMethods.join(', '));
    
    // Test additional InMemorySessionStorage methods
    const additionalMethods = ['getAllSessions', 'getStorageInfo'];
    const hasAdditional = additionalMethods.filter(method => typeof storage[method] === 'function');
    console.log('   ✓ Additional methods available:', hasAdditional.join(', '));
    
  } catch (error) {
    console.error('   ✗ Interface compliance check failed:', error.message);
    return false;
  }
  
  console.log('\n🎉 All verification tests passed!');
  console.log('\n📋 Summary:');
  console.log('   • InMemorySessionStorage is properly set as default');
  console.log('   • RoditClient correctly accesses the session manager');
  console.log('   • All storage operations work correctly');
  console.log('   • Storage interface is fully compliant');
  console.log('   • Additional debugging methods are available');
  
  return true;
}

async function showStorageDetails() {
  console.log('\n📊 Detailed Storage Information:');
  
  try {
    const client = new RoditClient();
    const storage = client.getSessionManager().storage;
    
    // Show storage info
    if (typeof storage.getStorageInfo === 'function') {
      const info = storage.getStorageInfo();
      console.log('   Storage Details:', JSON.stringify(info, null, 2));
    }
    
    // Show current sessions (should be empty)
    if (typeof storage.getAllSessions === 'function') {
      const sessions = storage.getAllSessions();
      console.log('   Current Sessions:', Object.keys(sessions).length === 0 ? 'None' : sessions);
    }
    
    // Show storage capabilities
    console.log('   Storage Capabilities:');
    console.log('     • Persistent: No (in-memory only)');
    console.log('     • Clustered: No (single process)');
    console.log('     • TTL Support: Via session expiration');
    console.log('     • Debugging: Yes (getAllSessions, getStorageInfo)');
    
  } catch (error) {
    console.error('   ✗ Failed to get storage details:', error.message);
  }
}

// Run verification if this file is executed directly
if (require.main === module) {
  verifyDefaultSetup()
    .then(success => {
      if (success) {
        return showStorageDetails();
      }
    })
    .then(() => {
      console.log('\n✅ Verification complete!');
    })
    .catch(error => {
      console.error('\n💥 Verification failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  verifyDefaultSetup,
  showStorageDetails
};
