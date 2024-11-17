import { sql } from '@vercel/postgres';
import {
  CustomerField,
  CustomersTableType,
  InvoiceForm,
  InvoicesTable,
  LatestInvoiceRaw,
  Revenue,
} from './definitions';
import { formatCurrency } from './utils';
import { unstable_noStore as noStore } from 'next/cache';

export const revalidate = 0

export async function fetchRevenue() {
  noStore();
  
  try {
    const data = await sql<Revenue>`SELECT * FROM revenue`;
    
    if (!data.rows) {
      throw new Error('No revenue data found');
    }
    
    return data.rows;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch revenue data. Please try again later.');
  }
}

export async function fetchLatestInvoices() {
  noStore();
  try {
    const data = await sql<LatestInvoiceRaw>`
      SELECT 
        invoices.amount, 
        customers.name, 
        customers.image_url, 
        customers.email, 
        invoices.id
      FROM invoices
      JOIN customers ON invoices.customer_id = customers.id
      ORDER BY invoices.date DESC
      LIMIT 5`;

    if (!data.rows.length) {
      return [];
    }

    const latestInvoices = data.rows.map((invoice) => ({
      ...invoice,
      amount: formatCurrency(invoice.amount),
    }));
    return latestInvoices;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch the latest invoices. Please try again later.');
  }
}

export async function fetchCardData() {
  noStore();
  
  try {
    const data = await sql`
      WITH invoice_stats AS (
        SELECT 
          COUNT(*) as invoice_count,
          SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) AS paid_amount,
          SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) AS pending_amount
        FROM invoices
      ),
      customer_stats AS (
        SELECT COUNT(*) as customer_count
        FROM customers
      )
      SELECT 
        invoice_stats.invoice_count,
        customer_stats.customer_count,
        invoice_stats.paid_amount,
        invoice_stats.pending_amount
      FROM invoice_stats, customer_stats;
    `;

    const stats = data.rows[0];
    
    return {
      numberOfCustomers: Number(stats.customer_count ?? '0'),
      numberOfInvoices: Number(stats.invoice_count ?? '0'),
      totalPaidInvoices: formatCurrency(stats.paid_amount ?? '0'),
      totalPendingInvoices: formatCurrency(stats.pending_amount ?? '0'),
    };
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch card data. Please try again later.');
  }
}

const ITEMS_PER_PAGE = 6;
export async function fetchFilteredInvoices(
  query: string,
  currentPage: number,
) {
  noStore();
  const offset = (currentPage - 1) * ITEMS_PER_PAGE;

  try {
    const sanitizedQuery = query.trim().replace(/[%_]/g, '\\$&');
    
    const invoices = await sql<InvoicesTable>`
      WITH filtered_invoices AS (
        SELECT
          i.id,
          i.amount,
          i.date,
          i.status,
          c.name,
          c.email,
          c.image_url
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        WHERE
          c.name ILIKE ${`%${sanitizedQuery}%`} OR
          c.email ILIKE ${`%${sanitizedQuery}%`} OR
          i.amount::text ILIKE ${`%${sanitizedQuery}%`} OR
          i.date::text ILIKE ${`%${sanitizedQuery}%`} OR
          i.status ILIKE ${`%${sanitizedQuery}%`}
      )
      SELECT *
      FROM filtered_invoices
      ORDER BY date DESC
      LIMIT ${ITEMS_PER_PAGE} OFFSET ${offset}
    `;

    if (!invoices.rows.length && currentPage > 1) {
      throw new Error('No more invoices found.');
    }

    return invoices.rows;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch invoices. Please try again later.');
  }
}

export async function fetchInvoicesPages(query: string) {
  noStore();
  try {
    const sanitizedQuery = query.trim().replace(/[%_]/g, '\\$&');
    
    const count = await sql`
      SELECT COUNT(*)
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      WHERE
        c.name ILIKE ${`%${sanitizedQuery}%`} OR
        c.email ILIKE ${`%${sanitizedQuery}%`} OR
        i.amount::text ILIKE ${`%${sanitizedQuery}%`} OR
        i.date::text ILIKE ${`%${sanitizedQuery}%`} OR
        i.status ILIKE ${`%${sanitizedQuery}%`}
    `;

    const totalPages = Math.ceil(Number(count.rows[0].count) / ITEMS_PER_PAGE);
    return totalPages;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch total number of invoices.');
  }
}

const DEFAULT_TIMEOUT = 5000; // 5 seconds

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = DEFAULT_TIMEOUT): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]);
}

export async function fetchInvoiceById(id: string) {
  noStore();
  try {

    const data = await withTimeout(
      sql<InvoiceForm>`
        SELECT
          i.id,
          i.customer_id,
          i.amount,
          i.status
        FROM invoices i
        WHERE i.id = ${id}
      `
    );

    // if (!data.rows.length) {
    //   throw new Error(`Invoice with ID ${id} not found`);
    // }

    const invoice = data.rows.map((invoice) => ({
      ...invoice,
      amount: invoice.amount / 100,
    }));

    console.log(invoice);

    return invoice[0];
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch invoice. Please try again later.');
  }
}

export async function fetchCustomers() {
  noStore();
  try {
    const data = await withTimeout(
      sql<CustomerField>`
        SELECT
          id,
          name
        FROM customers
        ORDER BY name ASC
      `
    );

    if (!data.rows.length) {
      return [];
    }

    return data.rows;
  } catch (err) {
    console.error('Database Error:', err);
    throw new Error('Failed to fetch customers. Please try again later.');
  }
}

export async function fetchFilteredCustomers(query: string) {
  noStore();
  try {
    const sanitizedQuery = query.trim().replace(/[%_]/g, '\\$&');

    const data = await withTimeout(
      sql<CustomersTableType>`
        WITH customer_metrics AS (
          SELECT
            c.id,
            c.name,
            c.email,
            c.image_url,
            COUNT(i.id) AS total_invoices,
            SUM(CASE WHEN i.status = 'pending' THEN i.amount ELSE 0 END) AS total_pending,
            SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END) AS total_paid
          FROM customers c
          LEFT JOIN invoices i ON c.id = i.customer_id
          WHERE
            c.name ILIKE ${`%${sanitizedQuery}%`} OR
            c.email ILIKE ${`%${sanitizedQuery}%`}
          GROUP BY c.id, c.name, c.email, c.image_url
        )
        SELECT *
        FROM customer_metrics
        ORDER BY name ASC
      `
    );

    if (!data.rows.length) {
      return [];
    }

    const customers = data.rows.map((customer) => ({
      ...customer,
      total_pending: formatCurrency(customer.total_pending || 0),
      total_paid: formatCurrency(customer.total_paid || 0),
    }));

    return customers;
  } catch (err) {
    console.error('Database Error:', err);
    throw new Error('Failed to fetch customer data. Please try again later.');
  }
}
