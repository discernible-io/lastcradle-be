// Configuration
const API_BASE_URL = 'http://167.99.5.69:3000'; // Adjust this to match your server's URL

// Function to perform login
async function login(peerRoditId, base64PeerRoditIdSignature) {
  try {
    const response = await fetch(`${API_BASE_URL}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        peer_rodit_id: peerRoditId,
        base64_peer_rodit_id_signature: base64PeerRoditIdSignature,
      }),
    });

    if (!response.ok) {
      throw new Error('Login failed');
    }

    const data = await response.json();
    return data.token;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
}

// Function to validate JWT (client-side validation)
function validateJWT(token) {
  // This is a basic check. For production, use a proper JWT library
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const payload = JSON.parse(atob(parts[1]));
  const currentTime = Math.floor(Date.now() / 1000);

  if (payload.exp && currentTime >= payload.exp) {
    throw new Error('Token has expired');
  }

  return payload;
}

// Function to access protected endpoint
async function accessProtectedEndpoint(token) {
  try {
    const response = await fetch(`${API_BASE_URL}/protected`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to access protected endpoint');
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Protected endpoint access error:', error);
    throw error;
  }
}

// Main function to demonstrate the flow
async function main() {
  try {
    // Example Rodit ID and signature (you would need to provide real values)
    const peerRoditId = 'example-rodit-id';
    const base64PeerRoditIdSignature = 'example-signature-in-base64';

    // Login and get token
    const token = await login(peerRoditId, base64PeerRoditIdSignature);
    console.log('Received token:', token);

    // Validate token
    const payload = validateJWT(token);
    console.log('Token payload:', payload);

    // Access protected endpoint
    const protectedData = await accessProtectedEndpoint(token);
    console.log('Protected endpoint response:', protectedData);
  } catch (error) {
    console.error('Error in main flow:', error);
  }
}

// Run the main function
main();