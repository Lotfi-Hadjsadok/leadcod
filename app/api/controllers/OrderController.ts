import { t } from 'elysia'
import { prisma } from '@/lib/prisma'
import { SHOPIFY_API_VERSION } from '@/lib/constants/shopify'
import { getPlanInfo } from '@/app/actions/plan'
import { PlanType } from '@/lib/constants/plan'

export class OrderController {
  static async createOrder(ctx: { body?: unknown; request?: Request }) {
    const body = (ctx.body ?? {}) as {
      shopUrl?: string
      name?: string
      phone?: string
      cityId?: string
      provinceId?: string
      productId?: string | number
      shippingType?: string
    }
    const { shopUrl, name, phone, cityId, provinceId, productId, shippingType } = body
    
    // Get IP address from request headers
    let ipAddress = 'Unknown'
    const request = ctx.request
    if (request) {
      const forwardedFor = request.headers.get('x-forwarded-for')
      const realIp = request.headers.get('x-real-ip')
      const cfConnectingIp = request.headers.get('cf-connecting-ip')
      ipAddress = cfConnectingIp || (forwardedFor ? forwardedFor.split(',')[0].trim() : null) || realIp || 'Unknown'
    }

    if (!shopUrl || !name || !phone || !cityId || !provinceId || productId === undefined || productId === null) {
      return {
        success: false,
        error: 'shopUrl, name, phone, cityId, provinceId, and productId are required',
        received: { shopUrl, name, phone, cityId, provinceId, productId }
      };
    }

    try {
      // Normalize shopUrl - remove protocol if present
      const normalizedShopUrl = shopUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      // Get shop and access token
      const shop = await prisma.shop.findFirst({
        where: { url: normalizedShopUrl }
      });

      if (!shop || !shop.accessToken) {
        return {
          success: false,
          error: 'Shop not found or access token not available'
        };
      }

      // Check if shop has exceeded free tier limit
      const planInfo = await getPlanInfo(normalizedShopUrl);
      if (planInfo.planType === PlanType.FREE && planInfo.orderCount >= planInfo.orderLimit) {
        return {
          success: false,
          error: `You have reached your free tier limit of ${planInfo.orderLimit} orders per month. Please upgrade to a paid plan to continue creating orders.`,
          planInfo: {
            orderCount: planInfo.orderCount,
            orderLimit: planInfo.orderLimit,
            paidTierPrice: planInfo.paidTierPrice
          }
        };
      }

      // Look up state and city by IDs to get names
      const [state, city] = await Promise.all([
        prisma.state.findUnique({
          where: { id: provinceId },
          select: { id: true, name: true, nameAr: true }
        }),
        prisma.city.findUnique({
          where: { id: cityId },
          select: { id: true, name: true, nameAr: true }
        })
      ]);

      if (!state) {
        return {
          success: false,
          error: 'Invalid provinceId'
        };
      }

      if (!city) {
        return {
          success: false,
          error: 'Invalid cityId'
        };
      }

      // Use state name for province (prefer name over nameAr for consistency)
      const provinceName = state.name;
      const cityName = city.name;

      // Calculate shipping price and label from backend
      let shippingPrice: number | null = null;
      let shippingLabel: string = 'Shipping';
      
      if (shippingType) {
        // Get shipping settings
        const shippingSettings = await prisma.shippingSettings.findUnique({
          where: { shopId: shop.id }
        });

        // Get shipping fee for this state (using provinceId directly)
        const shippingFee = await prisma.shippingFee.findUnique({
          where: {
            shopId_stateId: {
              shopId: shop.id,
              stateId: provinceId
            }
          }
        });

        if (shippingFee) {
          // Determine price based on shipping type
          if (shippingType === 'cod') {
            shippingPrice = shippingFee.cashOnDelivery ?? 0;
            shippingLabel = shippingSettings?.codLabel || 'Cash on Delivery';
          } else if (shippingType === 'stopDesk') {
            shippingPrice = shippingFee.stopDesk ?? 0;
            shippingLabel = shippingSettings?.stopDeskLabel || 'Stop Desk';
          }

          // If price is 0, use free shipping label
          if (shippingPrice === 0 && shippingSettings?.freeShippingLabel) {
            shippingLabel = shippingSettings.freeShippingLabel;
          }
        }
      }

      // Create the order on Shopify using productId directly as variant_id
      const baseUrl = `https://${normalizedShopUrl}/admin/api/${SHOPIFY_API_VERSION}`;
      
      // Convert productId to number if it's a string
      const variantId = typeof productId === 'string' ? parseInt(productId, 10) : productId;
      // Step 1: Check if customer exists by phone number
      let customerId: number | null = null;
      const searchUrl = `${baseUrl}/customers/search.json?query=phone:${encodeURIComponent(phone)}`;
      
      try {
        const searchResponse = await fetch(searchUrl, {
          method: 'GET',
          headers: {
            'X-Shopify-Access-Token': shop.accessToken,
            'Content-Type': 'application/json',
          },
        });

        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          if (searchData.customers && searchData.customers.length > 0) {
            customerId = searchData.customers[0].id;
          }
        }
      } catch (error) {
        // Customer search failed, will try to create new customer
      }

      // Step 2: If customer not found, try to create a new one
      if (!customerId) {
        try {
          const createCustomerUrl = `${baseUrl}/customers.json`;
          const customerResponse = await fetch(createCustomerUrl, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': shop.accessToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              customer: {
                first_name: name,
                last_name: '',
                phone: phone,
                addresses: [
                  {
                    first_name: name,
                    last_name: '',
                    city: cityName,
                    address1: provinceName,
                    province: provinceName,
                    country: 'Algeria',
                    phone: phone
                  }
                ]
              }
            }),
          });

          if (customerResponse.ok) {
            const customerData = await customerResponse.json();
            customerId = customerData.customer.id;
          } else {
            // If creation fails (e.g., phone already taken), search again
            const errorText = await customerResponse.text();
            
            const retrySearchResponse = await fetch(searchUrl, {
              method: 'GET',
              headers: {
                'X-Shopify-Access-Token': shop.accessToken,
                'Content-Type': 'application/json',
              },
            });

            if (retrySearchResponse.ok) {
              const retrySearchData = await retrySearchResponse.json();
              if (retrySearchData.customers && retrySearchData.customers.length > 0) {
                customerId = retrySearchData.customers[0].id;
              }
            }
          }
        } catch (error) {
          // Customer creation failed
        }
      }

      // Step 3: Create the order with customer ID
      const orderUrl = `${baseUrl}/orders.json`;
      
      // Build tags array: always include LEADCOD, and add COD or STOP_DESK based on shipping type
      const tags = ['LEADCOD'];
      if (shippingType === 'cod') {
        tags.push('COD');
      } else if (shippingType === 'stopDesk') {
        tags.push('STOP_DESK');
      }
      
      const orderData: any = {
        order: {
          line_items: [
            {
              variant_id: variantId,
              quantity: 1
            }
          ],
          financial_status: 'paid',
          fulfillment_status: null,
          tags: tags.join(', '),
          note_attributes: [
            {
              name: 'Province',
              value: provinceName
            },
            {
              name: 'City',
              value: cityName
            },
            {
              name: 'IP Address',
              value: ipAddress
            }
          ]
        }
      };

      // Add shipping price if calculated
      if (shippingPrice !== null && shippingPrice !== undefined) {
        orderData.order.shipping_lines = [
          {
            title: shippingLabel,
            price: shippingPrice.toString(),
            code: 'manual'
          }
        ];
      }

      // Add customer ID if we have one
      if (customerId) {
        orderData.order.customer = {
          id: customerId
        };
      }

      const orderResponse = await fetch(orderUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': shop.accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderData),
      });

      if (!orderResponse.ok) {
        const errorText = await orderResponse.text();
        return {
          success: false,
          error: `Failed to create order: ${orderResponse.status} ${orderResponse.statusText} - ${errorText}`
        };
      }

      const orderResult = await orderResponse.json();

      return {
        success: true,
        data: orderResult.order
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  static createOrderSchema = {
    body: t.Object({
      shopUrl: t.String(),
      name: t.String(),
      phone: t.String(),
      cityId: t.String(),
      provinceId: t.String(),
      productId: t.Union([t.String(), t.Number()]),
      shippingType: t.Optional(t.String())
    })
  }
}
