async function createRecipient() {
  const res = await fetch('https://api.paystack.co/transferrecipient', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'nuban',
      name: 'Jude Bespoke Tailoring',
      account_number: '0000000000', // Valid Paystack test account
      bank_code: '057', // Zenith Bank (test code)
      currency: 'NGN'
    })
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
createRecipient();
