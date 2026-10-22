import crypto from 'crypto';

async function trigger() {
  // We pull the key from your .env file to ensure it matches the server's key
  const secret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_c0bf253a2ecb0d3814ad071be6f63deecda09a55';
  
  // Use the reference from your browser redirect
  const reference = 'ord_d9b64eff-1b44-4cb4-a3ee-ac98693fca66'; 

  const payload = {
    event: 'charge.success',
    data: {
      reference: reference,
      amount: 5000000,
      status: 'success'
    }
  };

  const payloadString = JSON.stringify(payload);
  
  // Generate a valid Paystack signature so our backend accepts it
  const hash = crypto.createHmac('sha512', secret).update(payloadString).digest('hex');

  console.log('Sending valid webhook payload to localhost...');
  const res = await fetch('http://localhost:3000/webhooks/paystack', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-paystack-signature': hash
    },
    body: payloadString
  });
  
  console.log('Webhook response status:', res.status);
  const text = await res.text();
  console.log('Webhook response body:', text);
  process.exit(0);
}
trigger();
