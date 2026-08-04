import http from 'node:http';
let captured;
const stub = http.createServer((req,res)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname.endsWith('/checkout/intent')){
    captured=JSON.parse(b);
    if (u.searchParams.get('fail')==='1') {
      res.writeHead(400,{'content-type':'application/json'});
      return res.end(JSON.stringify({title:'Bad Request',httpStatus:400,traceId:'00-abc-123-01',
        context:[{code:'10103',message:'got string, want boolean',location:'BODY',field:'$.checkoutOptions.consumerProfileOptions.isSaveConsumerProfile'}]}));
    }
    res.writeHead(200,{'content-type':'application/json'});
    return res.end(JSON.stringify({checkoutSessionToken:'cst',merchantOrderNumber:captured.merchantOrderNumber}));
  }
  res.writeHead(404).end('{}');});});
await new Promise(r=>stub.listen(0,'127.0.0.1',r));
const port=stub.address().port;
process.env.JPM_CHECKOUT_API_URL=`http://api-mock.payments.jpmorgan.com:${port}/v1`;
const { createCheckoutIntent } = await import('./lib/jpmCheckout.js');
const args={merchantOrderNumber:'o1',amountCents:4999,currencyCode:'USD',consumer:{email:'a@b.com',billingAddress:{line1:'1 Main St'}}};
await createCheckoutIntent(args);
const v = captured.checkoutOptions.consumerProfileOptions.isSaveConsumerProfile;
console.log('isSaveConsumerProfile:', JSON.stringify(v), '| typeof:', typeof v);
console.log('serialized in body   :', JSON.stringify(captured.checkoutOptions.consumerProfileOptions));

// error formatting
process.env.JPM_CHECKOUT_API_URL=`http://api-mock.payments.jpmorgan.com:${port}/v1?fail=1`;
