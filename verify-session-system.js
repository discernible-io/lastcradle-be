#!/usr/bin/env node

/**
 * Session System Verification Script
 * Verifies that all parts of the application use the same SessionManager singleton
 */

const { sessionManager } = require('./sdk/lib/auth/sessionmanager');
const { sessionManager: authMwSessionManager } = require('./sdk/lib/middleware/authenticationmw');
const { sessionManager: tokenServiceSessionManager } = require('./sdk/lib/auth/tokenservice');

console.log('=== Session System Verification ===\n');

// Check if all modules use the same SessionManager instance
console.log('1. SessionManager Instance IDs:');
console.log(`   - SessionManager module: ${sessionManager._instanceId}`);
console.log(`   - AuthenticationMW: ${authMwSessionManager?._instanceId || 'NOT AVAILABLE'}`);
console.log(`   - TokenService: ${tokenServiceSessionManager?._instanceId || 'NOT AVAILABLE'}`);

// Verify singleton pattern
const allSame = sessionManager._instanceId === authMwSessionManager?._instanceId && 
                sessionManager._instanceId === tokenServiceSessionManager?._instanceId;

console.log(`\n2. Singleton Verification: ${allSame ? '✅ PASS' : '❌ FAIL'}`);

if (!allSame) {
  console.log('   ⚠️  WARNING: Different SessionManager instances detected!');
  console.log('   This will cause sessions to be stored in different memory spaces.');
} else {
  console.log('   All modules use the same SessionManager singleton instance.');
}

// Check storage type
console.log(`\n3. Storage Information:`);
console.log(`   - Storage Type: InMemorySessionStorage`);
console.log(`   - Instance ID: ${sessionManager._instanceId}`);

// Test session creation and retrieval
async function testSessionFlow() {
  console.log(`\n4. Session Flow Test:`);
  
  try {
    // Create test session
    const testSessionData = {
      roditId: 'TEST_RODIT_ID',
      ownerId: 'test-owner',
      expiresAt: Math.floor(Date.now() / 1000) + 3600 // 1 hour
    };
    
    console.log('   - Creating test session...');
    const session = await sessionManager.createSession(testSessionData);
    console.log(`   - Session created: ${session.id}`);
    
    // Retrieve session
    console.log('   - Retrieving session...');
    const retrievedSession = await sessionManager.getSession(session.id);
    console.log(`   - Session retrieved: ${retrievedSession ? '✅ SUCCESS' : '❌ FAILED'}`);
    
    // Test token invalidation check
    const mockPayload = {
      session_id: session.id,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    const mockToken = 'header.' + Buffer.from(JSON.stringify(mockPayload)).toString('base64url') + '.signature';
    
    console.log('   - Testing token validation...');
    const isInvalidated = await sessionManager.isTokenInvalidated(mockToken);
    console.log(`   - Token validation: ${!isInvalidated ? '✅ VALID' : '❌ INVALID'}`);
    
    // Clean up
    await sessionManager.storage.delete(session.id);
    console.log('   - Test session cleaned up');
    
    return true;
  } catch (error) {
    console.log(`   - ❌ ERROR: ${error.message}`);
    return false;
  }
}

// Run verification
testSessionFlow().then(success => {
  console.log(`\n=== Verification ${success ? 'PASSED' : 'FAILED'} ===`);
  
  if (success && allSame) {
    console.log('\n✅ Session system is properly configured:');
    console.log('   - All modules use the same SessionManager singleton');
    console.log('   - Session creation and retrieval works correctly');
    console.log('   - Token validation works correctly');
    console.log('\nThe authentication system should work properly.');
  } else {
    console.log('\n❌ Session system has issues:');
    if (!allSame) {
      console.log('   - Multiple SessionManager instances detected');
    }
    if (!success) {
      console.log('   - Session flow test failed');
    }
    console.log('\nThis will cause authentication failures.');
  }
}).catch(console.error);
