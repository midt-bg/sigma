import { isRouteErrorResponse } from 'react-router';

export interface ErrorCopy {
  kicker: string;
  title: string;
  lede: string;
  /** The document title; the error boundary bypasses route `meta`. */
  documentTitle: string;
}

/** The site-wide error page in the reader's terms: a missing record, a busy database — the 503 an
 *  overloaded D1 becomes, nothing broken, try again shortly — or anything else. */
export function errorCopy(error: unknown): ErrorCopy {
  const status = isRouteErrorResponse(error) ? error.status : null;
  if (status === 404)
    return {
      kicker: 'Грешка 404',
      title: 'Страницата не е намерена',
      lede: 'Такъв запис няма или адресът се е променил. Започни от търсенето или от някой от списъците.',
      documentTitle: 'Страницата не е намерена — СИГМА',
    };
  if (status === 503)
    return {
      kicker: 'Грешка',
      title: 'Сайтът е зает в момента',
      lede: 'В момента идват твърде много заявки наведнъж. Опитай пак след малко.',
      documentTitle: 'Грешка — СИГМА',
    };
  return {
    kicker: 'Грешка',
    title: 'Възникна грешка',
    lede: 'Нещо се обърка при зареждането. Опитай пак или се върни в началото.',
    documentTitle: 'Грешка — СИГМА',
  };
}
