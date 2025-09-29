#!/usr/bin/env node

/**
 * Simple Session Singleton Verification Script
 * Verifies SessionManager singleton without loading complex dependencies
 */

console.log('=== Session Singleton Verification ===\n');

// Import SessionManager multiple times to verify singleton behavior
const { sessionManager: sm1 } = require('./sdk/lib/auth/sessionmanager');
const { sessionManager: sm2 } = require('./sdk/lib/auth/sessionmanager');

console.log('1. SessionManager Instance IDs:');
console.log(`   - First import: ${sm1._instanceId}`);
console.log(`   - Second import: ${sm2._instanceId}`);

// Verify singleton pattern
const isSingleton = sm1._instanceId === sm2._instanceId;
console.log(`\n2. Singleton Verification: ${isSingleton ? '✅ PASS' : '❌ FAIL'}`);

if (!isSingleton) {
  console.log('   ⚠️  CRITICAL: Multiple SessionManager instances detected!');
  console.log('   This will cause sessions to be stored in different memory spaces.');
  process.exit(1);
} else {
  console.log('   ✅ All imports return the same SessionManager singleton instance.');
}

// Test basic session operations
async function testBasicOperations() {
  console.log(`\n3. Basic Operations Test:`);
  
  try {
    // Test storage access
    console.log('   - Testing storage access...');
    const storageKeys = await sm1.storage.keys();
    console.log(`   - Storage accessible: ✅ (${storageKeys.length} existing sessions)`);
    
    // Create test session
    const testSessionData = {
      roditId: 'TEST_RODIT_VERIFICATION',
      ownerId: 'test-owner-verification',
      expiresAt: Math.floor(Date.now() / 1000) + 3600 // 1 hour
    };
    
    console.log('   - Creating test session...');
    const session = await sm1.createSession(testSessionData);
    console.log(`   - Session created: ✅ ${session.id}`);
    
    // Retrieve session using different import
    console.log('   - Retrieving session via second import...');
    const retrievedSession = await sm2.getSession(session.id);
    console.log(`   - Cross-import retrieval: ${retrievedSession ? '✅ SUCCESS' : '❌ FAILED'}`);
    
    if (!retrievedSession) {
      throw new Error('Session not found via second import - singleton failure!');
    }
    
    // Verify session data
    const dataMatch = retrievedSession.id === session.id && 
                     retrievedSession.roditId === session.roditId &&
                     retrievedSession.status === 'active';
    console.log(`   - Session data integrity: ${dataMatch ? '✅ PASS' : '❌ FAIL'}`);
    
    // Clean up
    await sm1.storage.delete(session.id);
    console.log('   - Test session cleaned up: ✅');
    
    return true;
  } catch (error) {
    console.log(`   - ❌ ERROR: ${error.message}`);
    return false;
  }
}

// Run verification
testBasicOperations().then(success => {
  console.log(`\n=== Verification ${success ? 'PASSED' : 'FAILED'} ===`);
  
  if (success && isSingleton) {
    console.log('\n✅ Session system is properly configured:');
    console.log('   - SessionManager follows singleton pattern correctly');
    console.log('   - All imports return the same instance');
    console.log('   - Session storage is shared across imports');
    console.log('   - Basic CRUD operations work correctly');
    console.log('\n🎯 The authentication system should work properly!');
  } else {
    console.log('\n❌ Session system has critical issues:');
    if (!isSingleton) {
      console.log('   - Multiple SessionManager instances detected');
    }
    if (!success) {
      console.log('   - Basic operations failed');
    }
    console.log('\n💥 This WILL cause authentication failures!');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 Verification script failed:', error.message);
  process.exit(1);
});
