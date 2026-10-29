import { Link } from 'react-router';
import { Wordmark } from './Navbar';

export default function Footer() {
  return (
    <footer className="border-t border-line bg-bg/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Wordmark />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
            Offline fee awareness and stuck-transaction recovery for Bitcoin.
            FeePilot never controls miners and cannot guarantee that a
            transaction confirms. Fee estimates are probabilistic and change
            with the mempool.
          </p>
        </div>
        <nav aria-label="Product">
          <h2 className="text-sm font-semibold">Product</h2>
          <ul className="mt-4 space-y-2.5 text-sm text-muted">
            <li>
              <Link className="hover:text-fg" to="/app">
                Open the app
              </Link>
            </li>
            <li>
              <Link className="hover:text-fg" to="/app/fees">
                Fee snapshot
              </Link>
            </li>
            <li>
              <Link className="hover:text-fg" to="/app/orders">
                Order notes
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Learn">
          <h2 className="text-sm font-semibold">Learn</h2>
          <ul className="mt-4 space-y-2.5 text-sm text-muted">
            <li>
              <Link className="hover:text-fg" to="/how-it-works">
                How it works
              </Link>
            </li>
            <li>
              <Link className="hover:text-fg" to="/safety">
                Safety and privacy
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-muted sm:px-6">
          FeePilot is an early build. Do not use it with mainnet funds you
          cannot afford to lose. This is not financial advice.
        </p>
      </div>
    </footer>
  );
}
