const errors=require('./provider-errors');
const trace=require('./generation-log');
const insufficientCredits = message => /^\s*(credits? insufficient\b|insufficient credits?\b)/i.test(String(message||''));
const creditErrorMessage='Недостаточно кредитов Kie. Пополните баланс и повторите задачу через «Изменить и повторить».';
function responseError(status,body) {
  const error=new Error(body.msg||`Ошибка API: ${status}`);
  if(status===402||Number(body.code)===402||insufficientCredits(body.msg)){
    error.code='INSUFFICIENT_CREDITS';error.message=creditErrorMessage;
  }
  error.errorInfo=errors.classify({code:body.code??status,message:trace.clean(body.msg),stage:'request'});
  error.providerCode=body.code??status;
  error.outcome=[400,401,402,403,404,422,429].includes(Number(error.providerCode))?'rejected':'unknown';
  error.message=error.code==='INSUFFICIENT_CREDITS'?creditErrorMessage:error.errorInfo.message;
  return error;
}
module.exports={responseError,insufficientCredits,creditErrorMessage};
