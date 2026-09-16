const insufficientCredits = message => /^\s*(credits? insufficient\b|insufficient credits?\b)/i.test(String(message||''));
const creditErrorMessage='Недостаточно кредитов Kie. Пополните баланс и повторите задачу через «Изменить и повторить».';
function responseError(status,body) {
  const error=new Error(body.msg||`Ошибка API: ${status}`);
  if(status===402||Number(body.code)===402||insufficientCredits(body.msg)){
    error.code='INSUFFICIENT_CREDITS';error.message=creditErrorMessage;
  }
  return error;
}
module.exports={responseError,insufficientCredits,creditErrorMessage};
