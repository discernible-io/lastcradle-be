#!/usr/bin/env node
/**
 * Test script to verify token invalidation is working correctly
 * This script tests the exact same flow that the client tests are using
 */

const axios = require('axios');

const API_BASE = 'https://api.discernible.io:9443';

async function testTokenInvalidation() {
  console.log('🔍 Testing Token Invalidation Flow...\n');
  
  try {
    // Step 1: Login to get a JWT token
    console.log('1️⃣ Logging in to get JWT token...');
    const loginResponse = await axios.post(`${API_BASE}/api/sessions/login`, {
      roditid: 'AIBFCODAEJFDGBHFIAJFKHA',
      signature: 'test_signature',
      timestamp: Math.floor(Date.now() / 1000)
    });
    
    if (loginResponse.status !== 200) {
      throw new Error(`Login failed: ${loginResponse.status}`);
    }
    
    const token = loginResponse.data.jwt_token || loginResponse.data.token;
    if (!token) {
      throw new Error('No token received from login');
    }
    
    console.log(`✅ Login successful, token: ${token.substring(0, 20)}...`);
    
    // Step 2: Test protected endpoint with valid token
    console.log('\n2️⃣ Testing protected endpoint with valid token...');
    const echoResponse1 = await axios.get(`${API_BASE}/api/echo`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (echoResponse1.status !== 200) {
      throw new Error(`Echo test failed: ${echoResponse1.status}`);
    }
    
    console.log('✅ Protected endpoint accessible with valid token');
    
    // Step 3: Logout to invalidate the token
    console.log('\n3️⃣ Logging out to invalidate token...');
    const logoutResponse = await axios.post(`${API_BASE}/api/sessions/logout`, {
      reason: 'test_logout'
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (logoutResponse.status !== 200) {
      throw new Error(`Logout failed: ${logoutResponse.status}`);
    }
    
    console.log('✅ Logout successful');
    console.log('📋 Logout response:', JSON.stringify(logoutResponse.data, null, 2));
    
    // Step 4: Wait a moment to ensure invalidation is processed
    console.log('\n⏳ Waiting 100ms for invalidation to process...');
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Step 5: Test protected endpoint with invalidated token (should fail)
    console.log('\n4️⃣ Testing protected endpoint with invalidated token...');
    try {
      const echoResponse2 = await axios.get(`${API_BASE}/api/echo`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      // If we get here, the token was NOT invalidated (this is the bug)
      console.log('❌ BUG CONFIRMED: Token was NOT invalidated after logout!');
      console.log(`   Response status: ${echoResponse2.status}`);
      console.log(`   Response data: ${JSON.stringify(echoResponse2.data)}`);
      
      return {
        success: false,
        issue: 'Token invalidation not working',
        sessionProperlyClosed: false
      };
      
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ SUCCESS: Token properly invalidated - got 401 as expected');
        console.log(`   Error response: ${JSON.stringify(error.response.data)}`);
        
        return {
          success: true,
          issue: null,
          sessionProperlyClosed: true
        };
      } else {
        throw error; // Unexpected error
      }
    }
    
  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
    }
    
    return {
      success: false,
      issue: error.message,
      sessionProperlyClosed: false
    };
  }
}

// Run the test
testTokenInvalidation().then(result => {
  console.log('\n📊 Test Result:');
  console.log(JSON.stringify(result, null, 2));
  
  if (result.sessionProperlyClosed) {
    console.log('\n🎉 Token invalidation is working correctly!');
    process.exit(0);
  } else {
    console.log('\n🚨 Token invalidation is NOT working - this matches the client test failures');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 Test script failed:', error);
  process.exit(1);
});
