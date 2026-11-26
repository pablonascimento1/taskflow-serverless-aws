// Gatilho "Pre sign-up" do Cognito: confirma a conta na hora do cadastro,
// dispensando o código de verificação por e-mail (simplifica a demonstração).
export const handler = async (event) => {
  event.response.autoConfirmUser = true;
  if (event.request.userAttributes?.email) event.response.autoVerifyEmail = true;
  return event;
};
