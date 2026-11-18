import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Shopi Assist</h1>
        <p className={styles.text}>
          An AI shopping assistant for your Shopify storefront. Shoppers ask in
          plain language; answers come from your live catalog and policies.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Storefront chat widget</strong>. Product search, best
            sellers, policy answers and add to cart, inside a chat bubble that
            matches your brand color.
          </li>
          <li>
            <strong>Answers from real data</strong>. The assistant looks things
            up in your store instead of guessing prices, stock or policies.
          </li>
          <li>
            <strong>Store assistant for staff</strong>. Ask about top-selling
            products, sales totals, recent orders and low stock from inside
            Shopify admin.
          </li>
        </ul>
      </div>
    </div>
  );
}
