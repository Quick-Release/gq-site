// Site-owned public error presentation: never render thrown errors or private provider details.
export function ErrorPage() {
  return <main id="main-content" tabIndex={-1}><h1>Temporarily unavailable</h1><p>Please try again later.</p><a href="/">Back to the front page</a></main>;
}
