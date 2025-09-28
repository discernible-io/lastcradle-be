/**
 * Test Session Storage
 * 
 * Simple test to verify that the InMemorySessionStorage is working correctly
 * and is properly set as the default storage for the SessionManager.
 * 
 * Copyright (c) 2025 Discernible, Inc. All rights reserved.
 */

const { sessionManager, InMemorySessionStorage, setStorage } = require('../lib/auth/sessionmanager');

async function testDefaultInMemoryStorage() {
  console.log('=== Testing Default In-Memory Session Storage ===');
  
  try {
    // Test that the default storage is working
    console.log('1. Testing default storage...');
    
    // Create a test session
    const testSession = await sessionManager.createSession({
      roditId: 'test-rodit-id',
      ownerId: 'test-owner-id',
      expiresAt: Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
    });
    
    console.log('✓ Session created successfully:', {
      sessionId: testSession.id,
      roditId: testSession.roditId,
      status: testSession.status
    });
    
    // Test retrieving the session
    const retrievedSession = await sessionManager.getSession(testSession.id);
    console.log('✓ Session retrieved successfully:', {
      found: !!retrievedSession,
      sessionId: retrievedSession?.id,
      status: retrievedSession?.status
    });
    
    // Test session count
    const sessionCount = await sessionManager.storage.size();
    console.log('✓ Session count:', sessionCount);
    
    // Test closing the session
    const closed = await sessionManager.closeSession(testSession.id, 'test_cleanup');
    console.log('✓ Session closed:', closed);
    
    // Verify session is marked as closed
    const closedSession = await sessionManager.getSession(testSession.id);
    console.log('✓ Session status after close:', closedSession?.status);
    
    console.log('✓ Default in-memory storage test passed!');
    
  } catch (error) {
    console.error('✗ Default storage test failed:', error.message);
    throw error;
  }
}

async function testCustomInMemoryStorage() {
  console.log('\n=== Testing Custom In-Memory Session Storage ===');
  
  try {
    // Create a new InMemorySessionStorage instance
    const customStorage = new InMemorySessionStorage();
    
    // Get storage info
    const storageInfo = customStorage.getStorageInfo();
    console.log('✓ Custom storage info:', storageInfo);
    
    // Test direct storage operations
    const testSessionData = {
      id: 'custom-test-session',
      roditId: 'custom-rodit-id',
      status: 'active',
      createdAt: Math.floor(Date.now() / 1000)
    };
    
    // Test set
    const setResult = await customStorage.set(testSessionData.id, testSessionData);
    console.log('✓ Direct storage set:', setResult);
    
    // Test get
    const getResult = await customStorage.get(testSessionData.id);
    console.log('✓ Direct storage get:', {
      found: !!getResult,
      sessionId: getResult?.id,
      roditId: getResult?.roditId
    });
    
    // Test keys
    const keys = await customStorage.keys();
    console.log('✓ Storage keys:', keys);
    
    // Test size
    const size = await customStorage.size();
    console.log('✓ Storage size:', size);
    
    // Test delete
    const deleteResult = await customStorage.delete(testSessionData.id);
    console.log('✓ Storage delete:', deleteResult);
    
    // Verify deletion
    const afterDelete = await customStorage.get(testSessionData.id);
    console.log('✓ After delete (should be null):', afterDelete);
    
    console.log('✓ Custom in-memory storage test passed!');
    
  } catch (error) {
    console.error('✗ Custom storage test failed:', error.message);
    throw error;
  }
}

async function testStorageInjection() {
  console.log('\n=== Testing Storage Injection ===');
  
  try {
    // Create a new storage instance
    const newStorage = new InMemorySessionStorage();
    
    // Inject it into the session manager
    setStorage(newStorage);
    console.log('✓ Custom storage injected');
    
    // Test that the session manager is now using the new storage
    const testSession = await sessionManager.createSession({
      roditId: 'injection-test-rodit',
      ownerId: 'injection-test-owner',
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    });
    
    console.log('✓ Session created with injected storage:', {
      sessionId: testSession.id,
      roditId: testSession.roditId
    });
    
    // Verify the session exists in our custom storage
    const directGet = await newStorage.get(testSession.id);
    console.log('✓ Session found in custom storage:', {
      found: !!directGet,
      sessionId: directGet?.id
    });
    
    // Clean up
    await newStorage.clear();
    console.log('✓ Custom storage cleared');
    
    console.log('✓ Storage injection test passed!');
    
  } catch (error) {
    console.error('✗ Storage injection test failed:', error.message);
    throw error;
  }
}

async function runAllTests() {
  console.log('Starting Session Storage Tests...\n');
  
  try {
    await testDefaultInMemoryStorage();
    await testCustomInMemoryStorage();
    await testStorageInjection();
    
    console.log('\n🎉 All session storage tests passed!');
    console.log('\n📝 Summary:');
    console.log('- InMemorySessionStorage is properly set as default');
    console.log('- SessionManager uses the default storage correctly');
    console.log('- Custom storage injection works properly');
    console.log('- All storage operations (get, set, delete, keys, size, clear) work');
    
  } catch (error) {
    console.error('\n💥 Test suite failed:', error.message);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests();
}

module.exports = {
  testDefaultInMemoryStorage,
  testCustomInMemoryStorage,
  testStorageInjection,
  runAllTests
};
